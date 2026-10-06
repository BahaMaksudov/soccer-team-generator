import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { runMatchAutomation } from "@/lib/matchAutomation";

/**
 * M9.2 — organizer "Run now / Retry" for a scheduled Match (OWNER/ADMIN; MEMBER
 * / foreign → 404): runs only what is DUE for this Match, exactly as the
 * scheduler would (idempotent; never publishes teams).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const match = await findGroupMatch(context, matchId);
    if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    const run = await runMatchAutomation(new Date(), { groupId: context.activeGroup.id, matchId: match.id });
    return NextResponse.json({ ok: run.errors.length === 0, pollsPosted: run.pollsPosted, cutoffs: run.cutoffs, notified: run.notified });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
