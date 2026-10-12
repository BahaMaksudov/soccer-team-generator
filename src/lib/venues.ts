import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M9.2 — reusable Venues (grounds) of an Organization. Any Group of the
 * Organization may use them; another Organization's Venue is indistinguishable
 * from an unknown one (404). OWNER/ADMIN manage them; nothing is geocoded here.
 *
 * Phase 4B — isIndoor, and the organizer-CONFIRMED weather location
 * (src/lib/geocoding.ts). Changing the address clears that confirmation.
 */
export const CLEARED_LOCATION = { weatherLatitude: null, weatherLongitude: null, weatherLocationLabel: null, weatherLocationConfirmedAt: null, weatherLocationConfirmedByUserId: null };
export const venueSchema = z.object({
  name: z.string().trim().min(1, "Venue name is required.").max(80, "Keep the name under 80 characters."),
  address: z.string().trim().max(200, "Keep the address under 200 characters.").optional().nullable(),
});
export const venueUpdateSchema = venueSchema.partial().extend({ isActive: z.boolean().optional(), isIndoor: z.boolean().optional() });

/**
 * A safe, keyless maps destination for a free-text address (Google Maps search
 * URL — opens the Maps app on phones, the website elsewhere). Encoded with
 * encodeURIComponent; null when there is no address (never a broken link).
 */
export function mapsUrl(address: string | null | undefined): string | null {
  const a = (address ?? "").replace(/\s+/g, " ").trim();
  if (!a) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
}

/** A Venue of THIS Organization (null when foreign/unknown; active only when asked). */
export async function organizationVenue(organizationId: string, venueId: string, activeOnly = false) {
  if (typeof venueId !== "string" || !venueId || venueId.length > 64) return null;
  return prisma.venue.findFirst({ where: { id: venueId, organizationId, ...(activeOnly ? { isActive: true } : {}) }, select: { id: true, name: true, address: true, isActive: true } });
}

export async function listVenues(context: TenantContext): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const venues = await prisma.venue.findMany({
    where: { organizationId: context.organization.id },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, address: true, isActive: true, isIndoor: true, weatherLocationLabel: true, weatherLocationConfirmedAt: true },
  });
  return NextResponse.json({
    venues: venues.map(({ weatherLocationLabel, weatherLocationConfirmedAt, ...v }) => ({
      ...v,
      mapsUrl: mapsUrl(v.address),
      // Coordinates stay server-side; organizers see the confirmed label.
      weatherLocation: weatherLocationLabel && weatherLocationConfirmedAt ? { label: weatherLocationLabel, confirmedAt: weatherLocationConfirmedAt.toISOString() } : null,
    })),
  });
}

export async function createVenue(context: TenantContext, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = venueSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const venue = await prisma.venue.create({
    data: { organizationId: context.organization.id, name: parsed.data.name, address: parsed.data.address || null },
    select: { id: true, name: true, address: true, isActive: true },
  });
  return NextResponse.json({ ok: true, venue: { ...venue, mapsUrl: mapsUrl(venue.address) } }, { status: 201 });
}

export async function updateVenue(context: TenantContext, venueId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = venueUpdateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const venue = await organizationVenue(context.organization.id, venueId);
  if (!venue) return NextResponse.json({ error: "Venue not found" }, { status: 404 });
  const d = parsed.data;
  const newAddress = d.address !== undefined ? d.address || null : undefined;
  // Phase 4B — a changed address invalidates the confirmed weather location (the organizer confirms again).
  const addressChanged = newAddress !== undefined && (newAddress ?? "") !== (venue.address ?? "");
  await prisma.venue.updateMany({
    where: { id: venue.id, organizationId: context.organization.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(newAddress !== undefined ? { address: newAddress } : {}),
      ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
      ...(d.isIndoor !== undefined ? { isIndoor: d.isIndoor } : {}),
      ...(addressChanged ? CLEARED_LOCATION : {}),
    },
  });
  return NextResponse.json({ ok: true, ...(addressChanged ? { weatherLocationCleared: true } : {}) });
}
