import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { setAttendanceClosed } from "@/lib/matches";

/** M9-A — open/close attendance (no automatic cutoff). Any member; saves only, sends nothing. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await setAttendanceClosed(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
