import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { applySuggestedSwapForContext } from "@/lib/applySwap";

/**
 * M8-A — canonical, URL-bound "Apply Swap" for the Generate preview. Same
 * access as Generate itself (any member of the Organization for this Group;
 * wrong tenant → generic 404, anonymous → 401). Preview only: never
 * publishes, never posts to Telegram, never changes Players or settings.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { organizationSlug, groupSlug } = await params;
  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    return await applySuggestedSwapForContext(context, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
