import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { sendGameDayUpdateForContext } from "@/lib/gameDayManual";

/** Manual Game Day Update — send the confirmed preview (OWNER/ADMIN; one successful update per match). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await sendGameDayUpdateForContext(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
