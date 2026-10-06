import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { updateSchedule } from "@/lib/schedules";

/** M9.2 — edit / (de)activate a weekly schedule (OWNER/ADMIN; foreign → 404). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; scheduleId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { scheduleId, ...slugs } = await params;
  try {
    return await updateSchedule(await requireTenantContextForSlugs(slugs), scheduleId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
