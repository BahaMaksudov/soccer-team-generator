import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { markGameDayUpdateSentForContext } from "@/lib/gameDayManual";

/** Manual Game Day Update — mark an UNCERTAIN delivery as sent after checking Telegram (OWNER/ADMIN; never sends). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await markGameDayUpdateSentForContext(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
