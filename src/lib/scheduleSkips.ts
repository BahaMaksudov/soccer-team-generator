import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { billingConfig } from "@/lib/billing/config";
import { formatLongDateOnly } from "@/lib/dateOnly";

/**
 * Phase 2 — persistent warnings for recurring-schedule occurrences whose Match
 * was NOT created because the Organization's monthly new-match allowance was
 * reached (MatchScheduleSkip).
 *
 * - Idempotent: one row per (schedule, game date); repeated or concurrent
 *   automation runs only move lastSkippedAt (never a duplicate warning).
 * - Resolved automatically when the Match is created later (the allowance
 *   became available before the attendance cutoff).
 * - Dismissed by an OWNER/ADMIN (acknowledgedAt) — persistent across refreshes.
 * - Shown while neither resolved nor dismissed. Never changes the schedule,
 *   its Matches, polls or attendance.
 * - Tenant-scoped: every read and write is bound to the URL-resolved Group.
 */
export const SKIP_REASON_MONTHLY_LIMIT = "MONTHLY_MATCH_LIMIT";

export async function recordScheduleSkip(input: { groupId: string; scheduleId: string; occurrenceDate: Date; monthlyLimit: number; now: Date }): Promise<void> {
  const { groupId, scheduleId, occurrenceDate, monthlyLimit, now } = input;
  const where = { scheduleId_occurrenceDate: { scheduleId, occurrenceDate } };
  try {
    await prisma.matchScheduleSkip.upsert({
      where,
      update: { lastSkippedAt: now },
      create: { groupId, scheduleId, occurrenceDate, reason: SKIP_REASON_MONTHLY_LIMIT, monthlyLimit, firstSkippedAt: now, lastSkippedAt: now },
    });
  } catch (e) {
    // A concurrent run created it first: the warning exists exactly once.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    await prisma.matchScheduleSkip.updateMany({ where: { scheduleId, occurrenceDate }, data: { lastSkippedAt: now } });
  }
}

/** The occurrence's Match now exists: its warning (if any) is resolved. */
export async function resolveScheduleSkip(scheduleId: string, occurrenceDate: Date, now: Date): Promise<void> {
  await prisma.matchScheduleSkip.updateMany({ where: { scheduleId, occurrenceDate, resolvedAt: null }, data: { resolvedAt: now } });
}

const upgradeText = () => (billingConfig().enabled ? "Upgrade to Pro on your organization's Billing page for unlimited matches." : "Pro plans with unlimited matches are coming soon.");

/** "Your Free plan allows 4 new matches per month. The match scheduled for Saturday, October 31, 2026 was not created …" */
export function scheduleSkipMessage(skip: { occurrenceDate: Date; monthlyLimit: number }): string {
  return `Your Free plan allows ${skip.monthlyLimit} new matches per month. The match scheduled for ${formatLongDateOnly(skip.occurrenceDate)} was not created because your monthly limit was reached. Your recurring schedule is still active. ${upgradeText()}`;
}

export type ScheduleSkipView = { id: string; occurrenceDate: string; message: string; firstSkippedAt: string };

/** Open warnings (not resolved, not dismissed) of this Group, by schedule. */
export async function openScheduleSkips(groupId: string): Promise<Map<string, ScheduleSkipView[]>> {
  const rows = await prisma.matchScheduleSkip.findMany({
    where: { groupId, resolvedAt: null, acknowledgedAt: null },
    orderBy: [{ occurrenceDate: "asc" }, { id: "asc" }],
    select: { id: true, scheduleId: true, occurrenceDate: true, monthlyLimit: true, firstSkippedAt: true },
  });
  const out = new Map<string, ScheduleSkipView[]>();
  for (const r of rows) {
    const list = out.get(r.scheduleId) ?? [];
    list.push({ id: r.id, occurrenceDate: r.occurrenceDate.toISOString().slice(0, 10), message: scheduleSkipMessage(r), firstSkippedAt: r.firstSkippedAt.toISOString() });
    out.set(r.scheduleId, list);
  }
  return out;
}

/** OWNER/ADMIN: dismiss one warning of one of THIS Group's schedules (foreign / unknown → 404). */
export async function acknowledgeScheduleSkip(context: TenantContext, scheduleId: string, skipId: string): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const groupId = context.activeGroup.id;
  const skip = await prisma.matchScheduleSkip.findFirst({
    where: { id: typeof skipId === "string" ? skipId : "", scheduleId: typeof scheduleId === "string" ? scheduleId : "", groupId },
    select: { id: true, acknowledgedAt: true },
  });
  if (!skip) return NextResponse.json({ error: "Warning not found" }, { status: 404 });
  if (!skip.acknowledgedAt) {
    await prisma.matchScheduleSkip.updateMany({ where: { id: skip.id, groupId, acknowledgedAt: null }, data: { acknowledgedAt: new Date(), acknowledgedByUserId: context.user.id } });
  }
  return NextResponse.json({ ok: true });
}
