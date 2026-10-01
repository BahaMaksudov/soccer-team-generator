import { NextResponse } from "next/server";
import { resolveShareView } from "@/lib/shareLinks";
import { requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M6-A — public, no-account share-link viewing. The token arrives in the
 * POST body (the /share page reads it from the URL fragment), so it is
 * not part of any request URL/access log. Returns only allow-listed
 * player-facing data; every failure (unknown, revoked, foreign, PRIVATE,
 * inactive) is the same 404. Never cached or indexed; the token is
 * never logged.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const view = await resolveShareView(body?.token);
    if (!view) return NextResponse.json({ error: "This link is not valid." }, { status: 404, headers: HEADERS });
    return NextResponse.json(view, { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
