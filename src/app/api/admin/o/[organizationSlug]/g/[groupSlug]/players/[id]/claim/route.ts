import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { claimLinkPath, createPlayerClaim, revokePlayerClaims } from "@/lib/playerClaims";

/**
 * M6-C — canonical, URL-bound Player claim links (OWNER/ADMIN).
 * POST issues a new link for an unclaimed Player of this Group (revoking
 * any previous one); the raw token is returned ONCE as `claimPath`
 * (/claim#<token>) and is never stored or logged. DELETE revokes.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; id: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { organizationSlug, groupSlug, id } = await params;
  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    const result = await createPlayerClaim(context, id);
    if (!result.ok) {
      return result.code === "PLAYER_NOT_FOUND"
        ? NextResponse.json({ error: "Player not found" }, { status: 404 })
        : NextResponse.json({ error: "This player is already claimed by an account." }, { status: 409 });
    }
    return NextResponse.json(
      { ok: true, claimPath: claimLinkPath(result.token), expiresAt: result.expiresAt },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug, id } = await params;
  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    const revoked = await revokePlayerClaims(context, id);
    if (revoked === null) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    return NextResponse.json({ ok: true, revoked });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
