import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { keepOnlySchedule } from "@/lib/schedules";

/**
 * M11.1 — "Keep this schedule active": the organizer's explicit choice when
 * the Organization has more active schedules than its plan allows. Pauses
 * every other active schedule of the Organization (OWNER/ADMIN; MEMBER /
 * foreign → 404). Nothing is deleted; nothing is sent.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; scheduleId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { scheduleId, ...slugs } = await params;
  try {
    return await keepOnlySchedule(await requireTenantContextForSlugs(slugs), scheduleId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
