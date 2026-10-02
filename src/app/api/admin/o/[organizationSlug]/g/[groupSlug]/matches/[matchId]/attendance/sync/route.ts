import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { syncTelegramAttendance } from "@/lib/telegramAttendance";

/** M9-A — explicit "Sync Telegram attendance" (recovery for missed webhooks). Any member; returns counts only, never Telegram identities; sends nothing. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await syncTelegramAttendance(context, matchId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
