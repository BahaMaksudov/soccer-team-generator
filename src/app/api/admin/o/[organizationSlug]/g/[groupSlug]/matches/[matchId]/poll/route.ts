import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { postAttendancePoll } from "@/lib/telegramAttendance";

/** M9-A — explicit "Post attendance poll to Telegram" (OWNER/ADMIN; idempotent via MessageDelivery). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await postAttendancePoll(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
