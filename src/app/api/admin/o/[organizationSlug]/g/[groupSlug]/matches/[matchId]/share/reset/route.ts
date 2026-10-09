import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { organizerMatchShare, resetMatchLink } from "@/lib/matchLink";

/**
 * M9.3 — Reset Link (OWNER/ADMIN; MEMBER / foreign → 404): the previously
 * shared Match Link stops working immediately; returns the new link.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const id = typeof matchId === "string" ? matchId : "";
    if (!(await resetMatchLink(context.activeGroup.id, id))) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    const share = await organizerMatchShare(context.activeGroup.id, id);
    return NextResponse.json({ ok: true, ...(share ?? {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
