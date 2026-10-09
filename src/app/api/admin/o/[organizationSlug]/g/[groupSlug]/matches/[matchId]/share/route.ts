import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { organizerMatchShare } from "@/lib/matchLink";

/**
 * M9.3 — the Match's CURRENT Match Link for the organizer's Share card
 * (OWNER/ADMIN; MEMBER / foreign → 404). Deterministic: the same link until
 * Reset. 503 with an organizer-friendly message when match links are not
 * configured on the server; 409 when the Group is PRIVATE. Never cached.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const HEADERS = { "Cache-Control": "no-store" };

export async function GET(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const share = await organizerMatchShare(context.activeGroup.id, typeof matchId === "string" ? matchId : "");
    if (!share) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    if (!share.available) return NextResponse.json(share, { status: share.reason === "private" ? 409 : 503, headers: HEADERS });
    return NextResponse.json(share, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
