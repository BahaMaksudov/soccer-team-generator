import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createShareLink, revokeShareLinks, shareLinkPath } from "@/lib/shareLinks";

/**
 * M6-A — canonical, URL-bound share link management (OWNER/ADMIN).
 * POST creates a new link and revokes any previous one (rotation); the
 * raw token is returned ONCE in `sharePath` (/share#<token>) and is
 * never stored or logged. DELETE revokes every active link.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireTenantContextForSlugs(await params);
    const link = await createShareLink(context);
    return NextResponse.json(
      { ok: true, sharePath: shareLinkPath(link.token), createdAt: link.createdAt },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    const revoked = await revokeShareLinks(context);
    return NextResponse.json({ ok: true, revoked });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
