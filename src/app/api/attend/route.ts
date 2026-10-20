import { NextResponse } from "next/server";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { personalView } from "@/lib/personalAttendance";

/**
 * M12B — a player's personal attendance link (website-only matches): the view.
 * The token comes in the JSON body (the page reads it from the URL fragment), so it
 * never appears in a request URL / access log, and it is never logged. A bad,
 * foreign or inactive token is the same generic 404. Only the link's own Player.
 */
const PERSONAL_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("match-link-read", clientKey(req))).allowed) return NextResponse.json({ error: "Too many requests. Please try again in a few minutes." }, { status: 429, headers: PERSONAL_HEADERS });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const view = await personalView(body?.token);
    if (!view) return NextResponse.json({ error: "This link is not valid." }, { status: 404, headers: PERSONAL_HEADERS });
    return NextResponse.json(view, { headers: PERSONAL_HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: PERSONAL_HEADERS });
  }
}
