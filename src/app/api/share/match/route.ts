import { NextResponse } from "next/server";
import { resolveShareMatchView } from "@/lib/matchPage";
import { matchLinkResponse, matchLinkView } from "@/lib/matchLink";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";

/**
 * M9-C / M9.3 — anonymous access to ONE Match page. The token comes in the
 * POST body (the page reads it from the URL fragment), so it never appears in
 * a request URL/access log, and is never logged here.
 *
 *  - M9.3 Match Link token (per-Match HMAC): the player view + participation
 *    (roster display names with opaque refs while answers are open) and, with
 *    `playerRef`, that roster Player's current answer.
 *  - M9-C Group share-link token (LINK Groups): the read-only player view, as before.
 *
 * Every failure (bad/stale/revoked/foreign token, a Match of another Group,
 * PRIVATE, inactive, unknown reference) is the same 404. Allow-listed
 * player-facing data only.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const NOT_FOUND = () => NextResponse.json({ error: "This link is not valid." }, { status: 404, headers: HEADERS });

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("match-link-read", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const body = (await req.json().catch(() => null)) as { token?: unknown; matchId?: unknown; playerRef?: unknown } | null;
  try {
    const linked = await matchLinkView(body?.token, body?.matchId);
    if (linked) {
      const me = body?.playerRef !== undefined ? await matchLinkResponse(body?.token, body?.matchId, body.playerRef) : null;
      return NextResponse.json({ ...linked, me }, { headers: HEADERS });
    }
    const view = await resolveShareMatchView(body?.token, body?.matchId);
    if (!view) return NOT_FOUND();
    return NextResponse.json(view, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
