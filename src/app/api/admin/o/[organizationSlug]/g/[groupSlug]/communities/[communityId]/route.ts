import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { updateCommunity } from "@/lib/communities";

/** M9.2 — rename / activate / deactivate a Community (OWNER/ADMIN; foreign or unknown → 404). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; communityId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { communityId, ...slugs } = await params;
  try {
    return await updateCommunity(await requireTenantContextForSlugs(slugs), communityId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
