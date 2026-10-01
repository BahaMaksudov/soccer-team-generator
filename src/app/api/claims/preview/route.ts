import { NextResponse } from "next/server";
import { getClaimPreview } from "@/lib/playerClaims";
import { requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M6-C — read-only claim preview for the /claim page (token from the URL
 * fragment, sent in the POST body so it never appears in request logs).
 * Never consumes the claim. Shows only the Group and the Player's name.
 */
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    return NextResponse.json(await getClaimPreview(body?.token), { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
