import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { prisma } from "@/lib/prisma";
import { organizerRun } from "@/lib/matchAutomation";

/**
 * M9.2.1 — organizer "Run now" for a recurring schedule (OWNER/ADMIN; MEMBER /
 * foreign → 404). Runs only what is DUE for this schedule through the same
 * engine as the scheduler (idempotent; never publishes teams). Works while the
 * schedule is paused without resuming it.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; scheduleId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { scheduleId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const groupId = context.activeGroup.id;
    const schedule = await prisma.matchSchedule.findFirst({ where: { id: typeof scheduleId === "string" ? scheduleId : "", groupId }, select: { id: true } });
    if (!schedule) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    return NextResponse.json(await organizerRun(groupId, schedule.id));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
