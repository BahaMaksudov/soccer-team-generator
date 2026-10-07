import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createSchedule, listSchedules } from "@/lib/schedules";

/** M9.2 — weekly Match schedules of this Group (OWNER/ADMIN; MEMBER / foreign → 404). */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    return await listSchedules(await requireTenantContextForSlugs(await params));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    return await createSchedule(await requireTenantContextForSlugs(await params), req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
