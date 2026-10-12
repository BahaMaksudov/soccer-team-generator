import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { CLEARED_LOCATION, organizationVenue } from "@/lib/venues";
import { checkRateLimit } from "@/lib/rateLimit";
import { zodErrorResponse } from "@/lib/validation";

/**
 * Phase 4B (step 7) — venue weather LOCATION (geocoding), separate from the
 * weather forecast provider. Geoapify (Free plan; storing results is allowed
 * with attribution — see src/lib/weatherLegal.ts). Server-only key
 * GEOAPIFY_API_KEY; never sent to the browser.
 *
 * Never guessed: an organizer searches (city / ZIP / address), sees candidates
 * and explicitly confirms ONE. Candidates are signed by the server (HMAC,
 * 15 min, bound to the venue and Organization), so only a location the
 * provider returned and the organizer picked can be stored. Coordinates are
 * written only on confirmation; removing / replacing is explicit; changing
 * the venue address clears them (src/lib/venues.ts). OWNER/ADMIN of the
 * venue's Organization only; searches are rate-limited per organizer.
 */
export type GeoCandidate = { label: string; city: string | null; region: string | null; country: string | null; postcode: string | null; lat: number; lon: number };

export interface GeocodingProvider {
  search(text: string): Promise<GeoCandidate[]>;
}

export class GeocodingUnavailableError extends Error {}

const TIMEOUT_MS = 3000;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
const coord = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max ? v : null);

/** Geoapify forward geocoding (https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/). */
export function geoapifyProvider(apiKey: string): GeocodingProvider {
  return {
    async search(text) {
      const url = `https://api.geoapify.com/v1/geocode/search?${new URLSearchParams({ text, limit: "5", format: "json", apiKey })}`;
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new GeocodingUnavailableError("timeout or network error");
      }
      if (!res.ok) throw new GeocodingUnavailableError(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as { results?: unknown } | null;
      if (!data || !Array.isArray(data.results)) throw new GeocodingUnavailableError("malformed response");
      const out: GeoCandidate[] = [];
      for (const r of data.results as Array<Record<string, unknown>>) {
        const lat = coord(r?.lat, 90);
        const lon = coord(r?.lon, 180);
        const label = str(r?.formatted);
        if (lat === null || lon === null || !label) continue;
        out.push({ label, city: str(r.city), region: str(r.state), country: str(r.country), postcode: str(r.postcode), lat, lon });
      }
      return out;
    },
  };
}

let override: GeocodingProvider | null = null;
export function setGeocodingProviderForTests(p: GeocodingProvider | null) {
  override = p;
}
export function geocodingProvider(env: Record<string, string | undefined> = process.env): GeocodingProvider | null {
  if (override) return override;
  const key = env.GEOAPIFY_API_KEY?.trim();
  return key ? geoapifyProvider(key) : null;
}

// ---------------------------------------------------------------- signed candidates
type CandidateClaim = GeoCandidate & { v: string; o: string; exp: number };
const CANDIDATE_TTL_MS = 15 * 60_000;
function signingKey(): string | null {
  const s = process.env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}
const sign = (payload: string, key: string) => createHmac("sha256", `venue-location:${key}`).update(payload).digest("base64url");

export function signCandidate(c: GeoCandidate, venueId: string, organizationId: string, now = Date.now()): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ ...c, v: venueId, o: organizationId, exp: now + CANDIDATE_TTL_MS } satisfies CandidateClaim)).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function verifyCandidate(token: unknown, venueId: string, organizationId: string, now = Date.now()): GeoCandidate | null {
  const key = signingKey();
  if (!key || typeof token !== "string" || token.length > 4000) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CandidateClaim;
    if (c.v !== venueId || c.o !== organizationId || typeof c.exp !== "number" || c.exp < now) return null;
    if (coord(c.lat, 90) === null || coord(c.lon, 180) === null || !str(c.label)) return null;
    return { label: c.label, city: c.city ?? null, region: c.region ?? null, country: c.country ?? null, postcode: c.postcode ?? null, lat: c.lat, lon: c.lon };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- per-instance fallback limit (when Upstash is not configured)
const localHits = new Map<string, number[]>();
function localAllowed(key: string, limit = 20, windowMs = 10 * 60_000, now = Date.now()): boolean {
  const hits = (localHits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  localHits.set(key, hits);
  return true;
}
export function resetGeocodeLimitForTests() {
  localHits.clear();
}

const searchSchema = z.object({ query: z.string().trim().min(2, "Type a city, ZIP / postal code or address.").max(200, "That's too long.") });
const confirmSchema = z.object({ candidate: z.string().min(1).max(4000) });
const NOT_FOUND = () => NextResponse.json({ error: "Venue not found" }, { status: 404 });

/** OWNER/ADMIN: search candidate locations for a venue of THIS Organization (nothing is stored). */
export async function searchVenueLocation(context: TenantContext, venueId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const venue = await organizationVenue(context.organization.id, venueId);
  if (!venue) return NOT_FOUND();
  const parsed = searchSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const key = `${context.user.id}`;
  const shared = await checkRateLimit("geocode-search", key);
  if (!shared.allowed || !localAllowed(key)) return NextResponse.json({ error: "Too many location searches. Please wait a few minutes.", code: "RATE_LIMITED" }, { status: 429 });
  const provider = geocodingProvider();
  if (!provider) return NextResponse.json({ error: "Location search isn't configured.", code: "NOT_CONFIGURED" }, { status: 503 });
  let found: GeoCandidate[];
  try {
    found = await provider.search(parsed.data.query);
  } catch {
    return NextResponse.json({ error: "Location search is unavailable right now. Please try again.", code: "UNAVAILABLE" }, { status: 502 });
  }
  const candidates = found.slice(0, 5).map((c) => ({ ...c, token: signCandidate(c, venue.id, context.organization.id) })).filter((c) => c.token);
  return NextResponse.json({ candidates });
}

/** OWNER/ADMIN: confirm ONE signed candidate → store the venue's weather location (replaces any previous one). */
export async function confirmVenueLocation(context: TenantContext, venueId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const venue = await organizationVenue(context.organization.id, venueId);
  if (!venue) return NOT_FOUND();
  const parsed = confirmSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const c = verifyCandidate(parsed.data.candidate, venue.id, context.organization.id);
  if (!c) return NextResponse.json({ error: "That search result has expired. Search again and choose a location.", code: "INVALID_CANDIDATE" }, { status: 400 });
  await prisma.venue.updateMany({
    where: { id: venue.id, organizationId: context.organization.id },
    data: { weatherLatitude: c.lat, weatherLongitude: c.lon, weatherLocationLabel: c.label, weatherLocationConfirmedAt: new Date(), weatherLocationConfirmedByUserId: context.user.id },
  });
  return NextResponse.json({ ok: true, location: { label: c.label, lat: c.lat, lon: c.lon } });
}

/** OWNER/ADMIN: remove the venue's confirmed weather location. */
export async function removeVenueLocation(context: TenantContext, venueId: string): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const venue = await organizationVenue(context.organization.id, venueId);
  if (!venue) return NOT_FOUND();
  await prisma.venue.updateMany({ where: { id: venue.id, organizationId: context.organization.id }, data: CLEARED_LOCATION });
  return NextResponse.json({ ok: true });
}
