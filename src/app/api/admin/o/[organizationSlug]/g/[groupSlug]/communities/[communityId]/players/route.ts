import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { changeCommunityMembership } from "@/lib/communities";

/**
 * M9.2 — Community membership (OWNER/ADMIN; MEMBER / foreign → 404).
 * POST { playerId } adds (idempotent); DELETE { playerId } removes the
 * membership only — the Player and its other memberships are untouched.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; communityId: string }>;

async function run(req: Request, params: Params, action: "add" | "remove") {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { communityId, ...slugs } = await params;
  try {
    return await changeCommunityMembership(await requireTenantContextForSlugs(slugs), communityId, req, action);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export const POST = (req: Request, ctx: { params: Params }) => run(req, ctx.params, "add");
export const DELETE = (req: Request, ctx: { params: Params }) => run(req, ctx.params, "remove");
