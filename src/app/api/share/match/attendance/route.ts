import { NextResponse } from "next/server";
import { z } from "zod";
import { answerThroughMatchLink } from "@/lib/matchLink";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";

/**
 * M9.3 — an anonymous attendance answer through the Match Link (no account).
 * JSON only, same-origin only, rate-limited. The token (body, from the URL
 * fragment) must be the Match's CURRENT link; the player reference must be one
 * of that link's roster entries (active Community member); the Match must still
 * accept answers. Recorded as source LINK on the existing Player — never a new
 * Player; an organizer override keeps precedence. Invalid token / Match /
 * reference → the same generic 404. Nothing is logged.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const schema = z.object({
  token: z.string().max(64),
  matchId: z.string().max(64),
  playerRef: z.string().max(64),
  status: z.enum(["PLAYING", "MAYBE", "NOT_PLAYING"]),
});

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: HEADERS });
  if (!(await checkRateLimit("match-link-write", clientKey(req))).allowed) return NextResponse.json({ error: "Too many answers. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Playing, Maybe or Not playing." }, { status: 400, headers: HEADERS });
  const { token, matchId, playerRef, status } = parsed.data;
  try {
    const r = await answerThroughMatchLink(token, matchId, playerRef, status);
    if (r.ok) return NextResponse.json(r, { headers: HEADERS });
    if (r.reason === "closed") return NextResponse.json({ error: "Responses for this match are closed. Contact the organizer if your plans changed.", code: "CLOSED" }, { status: 409, headers: HEADERS });
    if (r.reason === "canceled") return NextResponse.json({ error: "This match was canceled.", code: "CANCELED" }, { status: 409, headers: HEADERS });
    return NextResponse.json({ error: "This link is not valid." }, { status: 404, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
