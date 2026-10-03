import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { postGameAction } from "@/lib/postGame";

/**
 * M9-D — post-game actions of a Match (result, MVP, recap, explicit posts).
 * Data actions follow Match editing; Telegram actions are OWNER/ADMIN.
 * Only "start_mvp" and "post_message" send anything.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await postGameAction(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
