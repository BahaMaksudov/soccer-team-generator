import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { setAttendanceOverride } from "@/lib/matches";

/** M9-A — organizer attendance override (set a status, or null to clear). Any member; saves only, sends nothing. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await setAttendanceOverride(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
