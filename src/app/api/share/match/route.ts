import { NextResponse } from "next/server";
import { resolveShareMatchView } from "@/lib/matchPage";
import { requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M9-C — share-link access to ONE Match page (LINK Groups). The token comes
 * in the POST body (the page reads it from the URL fragment), so it never
 * appears in a request URL/access log, and is never logged here. Every
 * failure (bad/revoked/foreign token, a Match of another Group, PRIVATE,
 * inactive) is the same 404. Allow-listed player-facing data only.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const body = (await req.json().catch(() => null)) as { token?: unknown; matchId?: unknown } | null;
  try {
    const view = await resolveShareMatchView(body?.token, body?.matchId);
    if (!view) return NextResponse.json({ error: "This link is not valid." }, { status: 404, headers: HEADERS });
    return NextResponse.json(view, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
