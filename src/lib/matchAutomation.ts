import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { canonicalAdminMatchPath } from "@/lib/matchPaths";
import { communityRosterIds, communityTelegramChat } from "@/lib/communities";
import { countAttendance, type AttendanceRow } from "@/lib/attendance";
import { postAttendancePollFor } from "@/lib/telegramAttendance";
import { closeMatchAttendancePolls, POLL_CLOSE_MESSAGE } from "@/lib/matchPollClose";
import { sendAttendanceReadyEmail } from "@/lib/email";
import { CUTOFF_CATCH_UP_MS, dueForPoll, type WeeklySchedule } from "@/lib/scheduleTime";

/**
 * M9.2 — the Match Automation Agent: deterministic orchestration (no AI).
 *
 * runMatchAutomation(now) is STATELESS and IDEMPOTENT — it does whatever is due
 * and may be called by any trigger (a cron, an organizer's "Run now", tests)
 * any number of times, concurrently:
 *
 *  1. CREATE — for every ACTIVE schedule occurrence whose poll time has come and
 *     whose cutoff has not: the Match (Group, Community, Venue, date/time) exists
 *     exactly once — UNIQUE (scheduleId, date) — with its MatchAutomation row
 *     (due instants fixed at creation).
 *  2. POLL — post the attendance poll to the Community's connected Telegram
 *     group through the existing poster (MessageDelivery reserve → send →
 *     finalize: same content already SENT is a no-op; an UNCERTAIN delivery is
 *     never retried automatically — the organizer decides in the Match).
 *  3. CUTOFF — when the cutoff has passed: close the Telegram poll (final sync
 *     first), close Team Balance Pro attendance, mark the step done
 *     (conditional update — once).
 *  4. NOTIFY — email each organizer (OWNER/ADMIN) the Playing / Maybe / Not
 *     playing / Not responded counts, idempotent PER RECIPIENT through
 *     MatchAutomationEmail: a recipient already sent to is never sent again, a
 *     failed one is retried on the next run, one recipient's failure never
 *     blocks the others; an organizer without a verified, well-formed email is
 *     skipped with a reason. The step completes (notifiedAt) once every
 *     organizer is sent or skipped.
 *  5. TEAMS — NEVER. Generating and publishing teams stays with the organizer.
 *
 * Every step runs as a real OWNER/ADMIN of the Group (the schedule's creator
 * while they are still an organizer, else the earliest OWNER), so all existing
 * authorization and tenant scoping apply unchanged. Failures are recorded on
 * MatchAutomation (lastError) for the organizer — never swallowed.
 *
 * Catch-up: steps are driven by durable due state, not by running inside an
 * exact window. A poll is posted any time after its due instant while
 * attendance is still open (before the cutoff) — never after. A cutoff (and
 * its email) is finalized any time within CUTOFF_CATCH_UP_MS (48 h) after it
 * is due; an organizer's "Run now" on one Match is not limited by that window.
 */

const NOTIFY_CLAIM_TIMEOUT_MS = 15 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AutomationRun = {
  schedules: number;
  created: number;
  pollsPosted: number;
  cutoffs: number;
  notified: number;
  errors: Array<{ matchId?: string; scheduleId?: string; error: string }>;
};

/** An OWNER/ADMIN acting context for a Group (preferring `preferredUserId` while still an organizer). */
export async function automationContext(groupId: string, preferredUserId: string | null): Promise<TenantContext | null> {
  const group = await prisma.group.findFirst({
    where: { id: groupId, isActive: true },
    select: { id: true, name: true, slug: true, sportKey: true, timezone: true, organization: { select: { id: true, name: true, slug: true } } },
  });
  if (!group) return null;
  const organizers = await prisma.organizationMembership.findMany({
    where: { organizationId: group.organization.id, role: { in: ["OWNER", "ADMIN"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, user: { select: { id: true, email: true, name: true } } },
  });
  const pick = organizers.find((m) => m.user.id === preferredUserId) ?? organizers.find((m) => m.role === "OWNER") ?? organizers[0];
  if (!pick) return null;
  const g = { id: group.id, name: group.name, slug: group.slug, sportKey: group.sportKey, timezone: group.timezone };
  return { user: pick.user, organization: group.organization, membership: { id: pick.id, role: pick.role }, groups: [g], activeGroup: g };
}

/**
 * One automation step-set per Match at a time: a transaction-scoped advisory
 * lock held while the steps run (their own writes use other connections). A
 * run that cannot take the lock skips the Match — another run is handling it.
 */
async function withMatchLock<T>(matchId: string, fn: () => Promise<T>): Promise<T | null> {
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${"automation:" + matchId})) AS locked`;
      return locked ? fn() : null;
    },
    { maxWait: 10_000, timeout: 120_000 }
  );
}

async function recordError(automationId: string, error: string) {
  await prisma.matchAutomation.update({ where: { id: automationId }, data: { lastError: error.slice(0, 300), lastErrorAt: new Date(), attempts: { increment: 1 } } });
}

type ScheduleRow = WeeklySchedule & { id: string; groupId: string; communityId: string; venueId: string | null; createdByUserId: string | null };

/** Step 1 — the occurrence's Match + automation row, exactly once. */
async function ensureMatch(s: ScheduleRow, occ: ReturnType<typeof dueForPoll>[number], ctx: TenantContext) {
  const date = toDateOnlyUTC(occ.gameDate);
  let match = await prisma.match.findFirst({ where: { scheduleId: s.id, date, groupId: s.groupId }, select: { id: true } });
  let created = false;
  if (!match) {
    const chat = await communityTelegramChat(s.groupId, s.communityId);
    const venue = s.venueId ? await prisma.venue.findFirst({ where: { id: s.venueId, organizationId: ctx.organization.id }, select: { id: true, name: true } }) : null;
    try {
      match = await prisma.match.create({
        data: {
          groupId: s.groupId,
          date,
          startTime: s.startTime,
          communityId: s.communityId,
          venueId: venue?.id ?? null,
          locationName: venue?.name ?? null,
          telegramChatId: chat?.id ?? null,
          scheduleId: s.id,
          createdByUserId: ctx.user.id,
        },
        select: { id: true },
      });
      created = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      match = await prisma.match.findFirstOrThrow({ where: { scheduleId: s.id, date, groupId: s.groupId }, select: { id: true } }); // a concurrent run created it
    }
  }
  let automation;
  try {
    automation = await prisma.matchAutomation.upsert({
      where: { matchId: match.id },
      update: {},
      create: { matchId: match.id, groupId: s.groupId, pollDueAt: occ.pollAt, cutoffDueAt: occ.cutoffAt },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    automation = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: match.id } }); // a concurrent run created it
  }
  return { matchId: match.id, automation, created };
}

/** Step 2 — post the attendance poll (once; never blindly retried after an uncertain delivery). */
async function stepPoll(ctx: TenantContext, matchId: string, automationId: string): Promise<"posted" | "skipped" | "error"> {
  const a = await prisma.matchAutomation.findUniqueOrThrow({ where: { id: automationId } });
  if (a.pollPostedAt) return "skipped";
  const m = await prisma.match.findFirst({ where: { id: matchId, groupId: ctx.activeGroup.id }, select: { status: true, communityId: true, telegramChatId: true, community: { select: { name: true } } } });
  if (!m || m.status === "CANCELED") return "skipped";
  let chatRef = m.telegramChatId;
  if (chatRef) {
    const ok = await prisma.telegramChat.findFirst({ where: { id: chatRef, groupId: ctx.activeGroup.id, disconnectedAt: null }, select: { id: true } });
    if (!ok) chatRef = null;
  }
  if (!chatRef && m.communityId) chatRef = (await communityTelegramChat(ctx.activeGroup.id, m.communityId))?.id ?? null;
  if (!chatRef) {
    await recordError(automationId, `The attendance poll could not be posted: no connected Telegram group for ${m.community?.name ?? "this community"}.`);
    return "error";
  }
  if (chatRef !== m.telegramChatId) await prisma.match.updateMany({ where: { id: matchId, groupId: ctx.activeGroup.id }, data: { telegramChatId: chatRef } });
  const res = await postAttendancePollFor(ctx, matchId, { chatRef, intent: "post" });
  const body = (await res.json().catch(() => ({}))) as { state?: string; error?: string };
  if (res.status === 200 || res.status === 201) {
    await prisma.matchAutomation.updateMany({ where: { id: automationId, pollPostedAt: null }, data: { pollPostedAt: new Date(), lastError: null } });
    return "posted";
  }
  await recordError(automationId, `The attendance poll could not be posted: ${body.error ?? `error ${res.status}`}`);
  return "error";
}

/** Step 3 — close the poll + attendance at the cutoff (idempotent; once). */
async function stepCutoff(ctx: TenantContext, matchId: string, automationId: string, now: Date): Promise<boolean> {
  const groupId = ctx.activeGroup.id;
  const poll = await closeMatchAttendancePolls(groupId, matchId);
  await prisma.match.updateMany({ where: { id: matchId, groupId, attendanceClosedAt: null }, data: { attendanceClosedAt: now } });
  const { count } = await prisma.matchAutomation.updateMany({ where: { id: automationId, cutoffCompletedAt: null }, data: { cutoffCompletedAt: now } });
  if (poll.status === "failed" || poll.status === "uncertain") await recordError(automationId, POLL_CLOSE_MESSAGE[poll.status]!);
  return count === 1;
}

/** Attendance summary over the Match's eligible roster (Community members, or the whole Group for a Community-less Match). */
export async function attendanceSummary(groupId: string, matchId: string) {
  const m = await prisma.match.findFirstOrThrow({
    where: { id: matchId, groupId },
    select: { date: true, communityId: true, attendanceClosedAt: true, community: { select: { name: true } }, attendance: { select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } } },
  });
  const ids = m.communityId ? await communityRosterIds(groupId, m.communityId) : (await prisma.player.findMany({ where: { groupId, isActive: true }, select: { id: true } })).map((p) => p.id);
  return { counts: countAttendance(ids, m.attendance as AttendanceRow[], m.attendanceClosedAt), rosterSize: ids.length, communityName: m.community?.name ?? null, date: m.date };
}

type Recipient = { userId: string; email: string; emailVerifiedAt: Date | null };
type RecipientOutcome = "sent" | "already_sent" | "skipped" | "in_progress" | "failed";

/** Send to one organizer at most once: claim its row (unique per automation + user), send, record. */
async function notifyRecipient(automationId: string, r: Recipient, now: Date, send: (to: string) => Promise<unknown>): Promise<RecipientOutcome> {
  const key = { automationId_userId: { automationId, userId: r.userId } };
  const existing = await prisma.matchAutomationEmail.findUnique({ where: key, select: { id: true, sentAt: true } });
  if (existing?.sentAt) return "already_sent";
  const skippedReason = !r.emailVerifiedAt ? "EMAIL_NOT_VERIFIED" : !EMAIL_RE.test(r.email) ? "INVALID_EMAIL" : null;
  if (skippedReason) {
    await prisma.matchAutomationEmail.upsert({ where: key, update: { skippedReason, claimedAt: null }, create: { automationId, userId: r.userId, skippedReason } });
    return "skipped";
  }
  const stale = new Date(now.getTime() - NOTIFY_CLAIM_TIMEOUT_MS);
  let claimed = false;
  if (!existing) {
    try {
      await prisma.matchAutomationEmail.create({ data: { automationId, userId: r.userId, claimedAt: now } });
      claimed = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; // a concurrent run claimed it
    }
  }
  if (!claimed) {
    const { count } = await prisma.matchAutomationEmail.updateMany({
      where: { automationId, userId: r.userId, sentAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
      data: { claimedAt: now, skippedReason: null },
    });
    if (count !== 1) return "in_progress";
  }
  try {
    await send(r.email);
  } catch (e) {
    await prisma.matchAutomationEmail.update({
      where: key,
      data: { claimedAt: null, attempts: { increment: 1 }, lastError: (e instanceof Error ? e.message : "Email delivery failed.").slice(0, 200) },
    });
    return "failed";
  }
  await prisma.matchAutomationEmail.update({ where: key, data: { sentAt: new Date(), claimedAt: null, skippedReason: null, lastError: null, attempts: { increment: 1 } } });
  return "sent";
}

/** Step 4 — email every organizer once (per-recipient; see notifyRecipient). */
async function stepNotify(ctx: TenantContext, matchId: string, automationId: string, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - NOTIFY_CLAIM_TIMEOUT_MS);
  const { count } = await prisma.matchAutomation.updateMany({
    where: { id: automationId, notifiedAt: null, cutoffCompletedAt: { not: null }, OR: [{ notifyClaimedAt: null }, { notifyClaimedAt: { lt: stale } }] },
    data: { notifyClaimedAt: now },
  });
  if (count !== 1) return false;
  try {
    const groupId = ctx.activeGroup.id;
    const summary = await attendanceSummary(groupId, matchId);
    // Every OWNER/ADMIN of the Organization (MEMBERs never), as of this run.
    const organizers = await prisma.organizationMembership.findMany({
      where: { organizationId: ctx.organization.id, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { id: true, email: true, emailVerifiedAt: true } } },
    });
    const a = await prisma.matchAutomation.findUniqueOrThrow({ where: { id: automationId }, select: { lastError: true } });
    const ymd = summary.date.toISOString().slice(0, 10);
    const send = (to: string) =>
      sendAttendanceReadyEmail({
        to,
        groupName: ctx.activeGroup.name,
        communityName: summary.communityName,
        matchLabel: formatLongDateOnly(ymd),
        counts: summary.counts,
        rosterSize: summary.rosterSize,
        pollNote: a.lastError?.includes("attendance poll") ? a.lastError : null,
        matchPath: canonicalAdminMatchPath(ctx.organization.slug, ctx.activeGroup.slug, matchId),
      });
    const outcomes: RecipientOutcome[] = [];
    for (const o of organizers) outcomes.push(await notifyRecipient(automationId, { userId: o.user.id, email: o.user.email, emailVerifiedAt: o.user.emailVerifiedAt }, now, send));
    const failed = outcomes.filter((x) => x === "failed").length;
    if (failed > 0 || outcomes.includes("in_progress")) {
      await prisma.matchAutomation.update({ where: { id: automationId }, data: { notifyClaimedAt: null } });
      if (failed > 0) await recordError(automationId, `The organizer email could not be sent to ${failed} of ${organizers.length} organizers; it will be retried (organizers already emailed are not emailed again).`);
      return false;
    }
    // Complete: every organizer was sent (now or earlier) or safely skipped.
    await prisma.matchAutomation.update({ where: { id: automationId }, data: { notifiedAt: new Date() } });
    await prisma.matchAutomation.updateMany({ where: { id: automationId, lastError: { startsWith: "The organizer email" } }, data: { lastError: null } });
    return true;
  } catch (e) {
    await prisma.matchAutomation.update({ where: { id: automationId }, data: { notifyClaimedAt: null } });
    await recordError(automationId, `The organizer email could not be sent (${e instanceof Error ? e.name : "error"}); it will be retried.`);
    return false;
  }
}

/** Run every due step (optionally for one Group / one Match). Never publishes teams. */
export async function runMatchAutomation(now: Date = new Date(), scope: { groupId?: string; matchId?: string } = {}): Promise<AutomationRun> {
  // Automatic runs finalize cutoffs within the catch-up window; an organizer's run for one Match is not limited by it.
  const cutoffFloor = scope.matchId ? undefined : new Date(now.getTime() - CUTOFF_CATCH_UP_MS);
  const run: AutomationRun = { schedules: 0, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, errors: [] };
  const schedules = (await prisma.matchSchedule.findMany({
    where: { isActive: true, group: { isActive: true }, community: { isActive: true }, ...(scope.groupId ? { groupId: scope.groupId } : {}) },
    select: { id: true, groupId: true, communityId: true, venueId: true, createdByUserId: true, timezone: true, weekday: true, startTime: true, pollDaysBefore: true, pollTime: true, cutoffDaysBefore: true, cutoffTime: true },
  })) as ScheduleRow[];
  run.schedules = schedules.length;
  const contexts = new Map<string, TenantContext | null>();
  const ctxFor = async (groupId: string, preferred: string | null) => {
    const key = `${groupId}:${preferred ?? ""}`;
    if (!contexts.has(key)) contexts.set(key, await automationContext(groupId, preferred));
    return contexts.get(key)!;
  };

  // 1 + 2 — create due Matches and post their polls.
  for (const s of schedules) {
    const ctx = await ctxFor(s.groupId, s.createdByUserId);
    if (!ctx) {
      run.errors.push({ scheduleId: s.id, error: "No owner or admin can run this schedule." });
      continue;
    }
    for (const occ of dueForPoll(s, now)) {
      try {
        const { matchId, automation, created } = await ensureMatch(s, occ, ctx);
        if (created) run.created++;
        if (scope.matchId && scope.matchId !== matchId) continue;
        if ((await withMatchLock(matchId, () => stepPoll(ctx, matchId, automation.id))) === "posted") run.pollsPosted++;
      } catch (e) {
        run.errors.push({ scheduleId: s.id, error: e instanceof Error ? e.message : "error" });
      }
    }
  }

  // 2b — polls still pending on existing scheduled Matches (e.g. a retry after a failure), by their stored due times.
  const pendingPolls = await prisma.matchAutomation.findMany({
    where: {
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.matchId ? { matchId: scope.matchId } : {}),
      pollPostedAt: null,
      pollDueAt: { lte: now },
      cutoffDueAt: { gt: now },
      match: { status: { not: "CANCELED" }, schedule: { isActive: true } },
    },
    select: { id: true, matchId: true, groupId: true, match: { select: { schedule: { select: { createdByUserId: true } } } } },
  });
  for (const a of pendingPolls) {
    const ctx = await ctxFor(a.groupId, a.match.schedule?.createdByUserId ?? null);
    if (!ctx) continue;
    try {
      if ((await withMatchLock(a.matchId, () => stepPoll(ctx, a.matchId, a.id))) === "posted") run.pollsPosted++;
    } catch (e) {
      run.errors.push({ matchId: a.matchId, error: e instanceof Error ? e.message : "error" });
    }
  }

  // 3 + 4 — cutoffs and notifications of scheduled Matches (active schedules only), within the catch-up window.
  const pending = await prisma.matchAutomation.findMany({
    where: {
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.matchId ? { matchId: scope.matchId } : {}),
      cutoffDueAt: { lte: now, ...(cutoffFloor ? { gte: cutoffFloor } : {}) },
      OR: [{ cutoffCompletedAt: null }, { notifiedAt: null }],
      match: { status: { not: "CANCELED" }, schedule: { isActive: true } },
    },
    select: { id: true, matchId: true, groupId: true, match: { select: { schedule: { select: { createdByUserId: true } } } } },
  });
  for (const a of pending) {
    const ctx = await ctxFor(a.groupId, a.match.schedule?.createdByUserId ?? null);
    if (!ctx) continue;
    try {
      const done = await withMatchLock(a.matchId, async () => {
        const fresh = await prisma.matchAutomation.findUniqueOrThrow({ where: { id: a.id }, select: { cutoffCompletedAt: true, notifiedAt: true } });
        const cut = !fresh.cutoffCompletedAt && (await stepCutoff(ctx, a.matchId, a.id, now));
        const sent = !fresh.notifiedAt && (await stepNotify(ctx, a.matchId, a.id, now));
        return { cut, sent };
      });
      if (done?.cut) run.cutoffs++;
      if (done?.sent) run.notified++;
    } catch (e) {
      run.errors.push({ matchId: a.matchId, error: e instanceof Error ? e.message : "error" });
    }
  }
  return run;
}
