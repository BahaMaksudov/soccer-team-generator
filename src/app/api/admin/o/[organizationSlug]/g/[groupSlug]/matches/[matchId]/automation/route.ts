import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { prisma } from "@/lib/prisma";
import { organizerRun } from "@/lib/matchAutomation";

/**
 * M9.2 — organizer "Run now / Retry" for a scheduled Match (OWNER/ADMIN; MEMBER
 * / foreign → 404): runs only what is DUE for this Match, exactly as the
 * scheduler would (idempotent; never publishes teams). Works while the
 * schedule is paused (an explicit override; the schedule stays paused).
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
    const scheduled = await prisma.match.findFirst({ where: { id: match.id, groupId: context.activeGroup.id }, select: { scheduleId: true } });
    if (!scheduled?.scheduleId) return NextResponse.json({ error: "This match is not part of a recurring schedule." }, { status: 400 });
    return NextResponse.json(await organizerRun(context.activeGroup.id, scheduled.scheduleId, match.id));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
