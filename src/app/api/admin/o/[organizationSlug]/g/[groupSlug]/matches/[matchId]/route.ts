import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { getMatchView, updateMatch } from "@/lib/matches";

/** M9-A — one Match (workspace view / edit). Scoped to the URL Group; foreign ids are 404. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await getMatchView(context, matchId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await updateMatch(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
