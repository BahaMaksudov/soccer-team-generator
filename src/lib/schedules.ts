import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";
import { groupCommunity } from "@/lib/communities";
import { organizationVenue } from "@/lib/venues";
import { isValidTimeZone, nextOccurrence, scheduleOrderError, type WeeklySchedule } from "@/lib/scheduleTime";
import { assertCapacity, organizationPlan } from "@/lib/entitlements";

/**
 * M9.2 — weekly recurring Match schedules of a Group (OWNER/ADMIN). A schedule
 * names its Community (roster + Telegram channel), optional Venue, IANA
 * timezone, game weekday/time, poll and cutoff wall times. Editing a schedule
 * affects Matches it creates from now on; a Match already created keeps the
 * due times it was created with. A deactivated schedule creates nothing and
 * its pending automation stops.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use a 24-hour HH:MM time.");
const days = z.number().int().min(0).max(6);
export const scheduleSchema = z.object({
  communityId: z.string().trim().min(1).max(64),
  venueId: z.string().trim().min(1).max(64).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  weekday: z.number().int().min(0).max(6),
  startTime: hhmm,
  pollDaysBefore: days,
  pollTime: hhmm,
  cutoffDaysBefore: days,
  cutoffTime: hhmm,
  isActive: z.boolean().optional(),
});
export const scheduleUpdateSchema = scheduleSchema.partial();

const SELECT = {
  id: true,
  communityId: true,
  venueId: true,
  timezone: true,
  weekday: true,
  startTime: true,
  pollDaysBefore: true,
  pollTime: true,
  cutoffDaysBefore: true,
  cutoffTime: true,
  isActive: true,
  community: { select: { name: true } },
  venue: { select: { name: true } },
} as const;

type Row = WeeklySchedule & { id: string; communityId: string; venueId: string | null; isActive: boolean; community: { name: string }; venue: { name: string } | null };

export function scheduleView(r: Row, now = new Date()) {
  const next = nextOccurrence(r, now);
  return {
    id: r.id,
    communityId: r.communityId,
    communityName: r.community.name,
    venueId: r.venueId,
    venueName: r.venue?.name ?? null,
    timezone: r.timezone,
    weekday: r.weekday,
    startTime: r.startTime,
    pollDaysBefore: r.pollDaysBefore,
    pollTime: r.pollTime,
    cutoffDaysBefore: r.cutoffDaysBefore,
    cutoffTime: r.cutoffTime,
    isActive: r.isActive,
    next: { gameDate: next.gameDate, gameAt: next.gameAt.toISOString(), pollAt: next.pollAt.toISOString(), cutoffAt: next.cutoffAt.toISOString() },
  };
}

/** Validate references + order; returns the data to store or an error response. */
async function validate(context: TenantContext, input: z.infer<typeof scheduleUpdateSchema>, base?: Row) {
  const groupId = context.activeGroup.id;
  const merged = {
    communityId: input.communityId ?? base?.communityId,
    venueId: input.venueId !== undefined ? input.venueId : (base?.venueId ?? null),
    timezone: input.timezone ?? base?.timezone ?? context.activeGroup.timezone,
    weekday: input.weekday ?? base?.weekday,
    startTime: input.startTime ?? base?.startTime,
    pollDaysBefore: input.pollDaysBefore ?? base?.pollDaysBefore,
    pollTime: input.pollTime ?? base?.pollTime,
    cutoffDaysBefore: input.cutoffDaysBefore ?? base?.cutoffDaysBefore,
    cutoffTime: input.cutoffTime ?? base?.cutoffTime,
  };
  const bad = (error: string, status = 400) => ({ ok: false as const, response: NextResponse.json({ error }, { status }) });
  if (!merged.communityId || !(await groupCommunity(groupId, merged.communityId, true))) return bad("Community not found", 404);
  if (merged.venueId && !(await organizationVenue(context.organization.id, merged.venueId, true))) return bad("Venue not found", 404);
  if (!isValidTimeZone(merged.timezone)) return bad("Choose a valid time zone.");
  const order = scheduleOrderError(merged as WeeklySchedule);
  if (order) return bad(order);
  return { ok: true as const, data: merged as WeeklySchedule & { communityId: string; venueId: string | null } };
}

export async function listSchedules(context: TenantContext): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const rows = await prisma.matchSchedule.findMany({ where: { groupId: context.activeGroup.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: SELECT /* stable: pausing never moves a card */ });
  // M11.1 — whether the Organization's automation is paused because it has more active schedules than its plan allows.
  return NextResponse.json({ schedules: (rows as Row[]).map((r) => scheduleView(r)), planLimit: await schedulesOverLimit(context.organization.id) });
}

export async function createSchedule(context: TenantContext, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = scheduleSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const v = await validate(context, parsed.data);
  if (!v.ok) return v.response;
  // M11.1 — an active schedule counts toward the plan (Organization-locked, same transaction).
  const isActive = parsed.data.isActive ?? true;
  const row = await prisma.$transaction(async (tx) => {
    if (isActive) await assertCapacity(tx, context.organization.id, "activeSchedules");
    return tx.matchSchedule.create({
      data: { groupId: context.activeGroup.id, ...v.data, isActive, createdByUserId: context.user.id },
      select: SELECT,
    });
  });
  return NextResponse.json({ ok: true, schedule: scheduleView(row as Row) }, { status: 201 });
}

export async function updateSchedule(context: TenantContext, scheduleId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = scheduleUpdateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const base = (await prisma.matchSchedule.findFirst({ where: { id: typeof scheduleId === "string" ? scheduleId : "", groupId }, select: SELECT })) as Row | null;
  if (!base) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  const v = await validate(context, parsed.data, base);
  if (!v.ok) return v.response;
  // M11.1 — re-activating a paused schedule counts toward the plan; pausing / editing never does.
  await prisma.$transaction(async (tx) => {
    if (parsed.data.isActive === true && !base.isActive) await assertCapacity(tx, context.organization.id, "activeSchedules");
    await tx.matchSchedule.updateMany({ where: { id: base.id, groupId }, data: { ...v.data, ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}) } });
  });
  const row = await prisma.matchSchedule.findFirstOrThrow({ where: { id: base.id, groupId }, select: SELECT });
  return NextResponse.json({ ok: true, schedule: scheduleView(row as Row) });
}

/**
 * M11.1 — downgrade: when the Organization has more active schedules than its
 * plan allows, ALL of its automation pauses (nothing is chosen silently). The
 * organizer picks the one schedule to keep: this one stays active and every
 * other active schedule of the Organization is paused (never deleted; their
 * Matches are untouched) — exactly one active schedule remains, which every
 * plan allows (OWNER/ADMIN; foreign → 404).
 */
export async function keepOnlySchedule(context: TenantContext, scheduleId: string): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const groupId = context.activeGroup.id;
  const organizationId = context.organization.id;
  const target = await prisma.matchSchedule.findFirst({ where: { id: typeof scheduleId === "string" ? scheduleId : "", groupId }, select: { id: true, isActive: true } });
  if (!target) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  const paused = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"entitlement:" + organizationId}))`;
    const { count } = await tx.matchSchedule.updateMany({ where: { isActive: true, id: { not: target.id }, group: { organizationId } }, data: { isActive: false } });
    await tx.matchSchedule.updateMany({ where: { id: target.id, groupId }, data: { isActive: true } });
    return count;
  });
  return NextResponse.json({ ok: true, paused });
}

/** M11.1 — schedules of this Organization exceed its plan (automation paused until the organizer chooses). */
export async function schedulesOverLimit(organizationId: string): Promise<{ over: boolean; active: number; limit: number | null }> {
  const { limits } = await organizationPlan(organizationId);
  const active = await prisma.matchSchedule.count({ where: { isActive: true, group: { organizationId } } });
  return { over: limits.activeSchedules !== null && active > limits.activeSchedules, active, limit: limits.activeSchedules };
}
