import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { listJoinRequests } from "@/lib/groupJoin";

/**
 * M13A — the Group's join requests (pending first, then recent decisions) and the
 * Group's UNCLAIMED Players an applicant can be linked to. OWNER/ADMIN only
 * (MEMBER / foreign → generic 404). Applicant emails are shown to organizers only.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    return NextResponse.json(await listJoinRequests(context), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
