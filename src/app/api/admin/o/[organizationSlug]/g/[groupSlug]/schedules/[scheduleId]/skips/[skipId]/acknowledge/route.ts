import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { acknowledgeScheduleSkip } from "@/lib/scheduleSkips";

/**
 * Phase 2 — dismiss a "match not created (monthly limit)" warning of one of
 * this Group's recurring schedules (OWNER/ADMIN; MEMBER / foreign → 404).
 * Changes nothing else: the schedule, its Matches and attendance stay as they are.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; scheduleId: string; skipId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { scheduleId, skipId, ...slugs } = await params;
  try {
    return await acknowledgeScheduleSkip(await requireTenantContextForSlugs(slugs), scheduleId, skipId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
