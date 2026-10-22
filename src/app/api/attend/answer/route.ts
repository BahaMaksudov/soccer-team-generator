import { NextResponse } from "next/server";
import { z } from "zod";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { answerPersonal } from "@/lib/personalAttendance";

/**
 * M12B — save the answer of the personal link's OWN Player (website-only matches).
 * JSON + same-origin only; the Player is taken from the link row, never from the
 * request. Rate limits: per client address (Upstash, optional) and per link (database).
 * The organizer override keeps precedence. Never logs the token.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const schema = z.object({ token: z.string().max(100), status: z.enum(["PLAYING", "MAYBE", "NOT_PLAYING"]) });
const MESSAGES: Record<string, { status: number; error: string }> = {
  invalid: { status: 404, error: "This link is not valid." },
  revoked: { status: 410, error: "This link was replaced or revoked. Ask your organizer for your current link." },
  replaced: { status: 410, error: "A newer invitation was sent for this match. Please use the link in the most recent email." },
  closed: { status: 409, error: "Responses for this match are closed. Contact the organizer if your plans changed." },
  canceled: { status: 409, error: "This match was canceled." },
  telegram: { status: 409, error: "This match uses your group's Telegram poll for attendance — please vote there." },
  rate_limited: { status: 429, error: "Too many changes. Please try again in a few minutes." },
};

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: HEADERS });
  if (!(await checkRateLimit("match-link-write", clientKey(req))).allowed) return NextResponse.json({ error: "Too many answers. Please try again in a few minutes." }, { status: 429, headers: HEADERS });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Playing, Maybe or Not playing." }, { status: 400, headers: HEADERS });
  try {
    const r = await answerPersonal(parsed.data.token, parsed.data.status);
    if (r.ok) return NextResponse.json(r, { headers: HEADERS });
    const m = MESSAGES[r.reason] ?? MESSAGES.invalid;
    return NextResponse.json({ error: m.error, code: r.reason }, { status: m.status, headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
