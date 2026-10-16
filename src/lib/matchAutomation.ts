import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { canonicalAdminMatchPath } from "@/lib/matchPaths";
import { communityTelegramChat } from "@/lib/communities";
import { matchAttendanceSnapshot, type AttendanceSnapshot } from "@/lib/attendanceSnapshot";
import { postAttendancePollFor } from "@/lib/telegramAttendance";
import { closeMatchAttendancePolls, POLL_CLOSE_MESSAGE } from "@/lib/matchPollClose";
import { sendAttendanceReadyEmail } from "@/lib/email";
import { assertCapacity, EntitlementError, organizationPlan, telegramEntitledSince } from "@/lib/entitlements";
import { schedulesOverLimit } from "@/lib/schedules";
import { currentMatchLinkPath } from "@/lib/matchLink";
import { CUTOFF_CATCH_UP_MS, dueForPoll, type WeeklySchedule } from "@/lib/scheduleTime";
import { recordScheduleSkip, resolveScheduleSkip, scheduleSkipMessage } from "@/lib/scheduleSkips";
import { attendanceIsClosed, effectiveClosedAt } from "@/lib/attendanceDeadline";
import { deliverGameDayUpdate } from "@/lib/gameDayUpdate";
import { readGameDayUpdateSettings } from "@/lib/gameDayUpdateSettings";
import { MIN_LEFT_MS } from "@/lib/gameDayUpdateSchedule";

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
 *  2. POLL — Telegram is optional (M9.3): a Community WITHOUT a connected
 *     Telegram group collects attendance through the Match Link, so the step
 *     simply completes (no Telegram call, no error). Otherwise post the
 *     attendance poll to the Community's connected Telegram group through the
 *     existing poster (MessageDelivery reserve → send →
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
 *
 * Paused schedules: automatic (scheduler-triggered) runs ignore them entirely.
 * An organizer's Run now (organizerRun) is an explicit override for ONE
 * schedule: it runs that schedule's due steps even while paused — through the
 * same steps and idempotency guards — and never changes isActive.
 */

const NOTIFY_CLAIM_TIMEOUT_MS = 15 * 60_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AutomationRun = {
  schedules: number;
  created: number;
  pollsPosted: number;
  cutoffs: number;
  notified: number;
  /** M11.1 — matches not created because the Organization reached its monthly match limit. */
  limited: number;
  /** M11.1 — schedule steps skipped because the Organization has more active schedules than its plan allows (organizer must choose). */
  paused: number;
  /** Phase 4B — attendance finalized at a passed deadline outside the recurring cutoff step (manual Matches; recurring ones reopened with a new deadline). */
  deadlinesClosed: number;
  /** Phase 4B — Game Day Updates sent; and ones Telegram rejected / did not confirm (shown on the match page). */
  gameDayUpdates: number;
  gameDayProblems: number;
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
async function ensureMatch(s: ScheduleRow, occ: ReturnType<typeof dueForPoll>[number], ctx: TenantContext, now: Date) {
  const date = toDateOnlyUTC(occ.gameDate);
  let match = await prisma.match.findFirst({ where: { scheduleId: s.id, date, groupId: s.groupId }, select: { id: true } });
  let created = false;
  if (!match) {
    const chat = await communityTelegramChat(s.groupId, s.communityId);
    const venue = s.venueId ? await prisma.venue.findFirst({ where: { id: s.venueId, organizationId: ctx.organization.id }, select: { id: true, name: true } }) : null;
    try {
      // M11.1 — an automatic Match counts toward the monthly match limit like a manual one
      // (Phase 2: measured at this run's instant, the same UTC-month rule as manual creation).
      match = await prisma.$transaction(async (tx) => {
        await assertCapacity(tx, ctx.organization.id, "monthlyMatches", now);
        return tx.match.create({
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
            // Phase 4B — the occurrence cutoff IS the Match's attendance deadline (equal to MatchAutomation.cutoffDueAt).
            attendanceDeadlineAt: occ.cutoffAt,
          },
          select: { id: true },
        });
      });
      created = true;
      await resolveScheduleSkip(s.id, date, now);
    } catch (e) {
      if (e instanceof EntitlementError) {
        // Plan limit: nothing created, nothing sent; the schedule stays active. Phase 2 — a
        // persistent, de-duplicated warning for this occurrence (retried by later runs until its
        // cutoff; resolved if the Match is created then).
        if (e.metric === "monthlyMatches" && e.limit !== null) await recordScheduleSkip({ groupId: s.groupId, scheduleId: s.id, occurrenceDate: date, monthlyLimit: e.limit, now });
        return null;
      }
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
async function stepPoll(ctx: TenantContext, matchId: string, automationId: string, telegramAllowed = true, entitledSince: Date | null = null): Promise<"posted" | "link" | "skipped" | "error"> {
  const a = await prisma.matchAutomation.findUniqueOrThrow({ where: { id: automationId } });
  if (a.pollPostedAt) return "skipped";
  // M11.3 — a poll that fell due while the organization was on Free is not posted late after an
  // upgrade (no replay): this match stays on the match link; the organizer may still post manually.
  if (entitledSince && a.pollDueAt.getTime() < entitledSince.getTime()) telegramAllowed = false;
  const m = await prisma.match.findFirst({
    where: { id: matchId, groupId: ctx.activeGroup.id },
    select: { status: true, communityId: true, telegramChatId: true, attendanceClosedAt: true, attendanceDeadlineAt: true, community: { select: { name: true } } },
  });
  if (!m || m.status === "CANCELED") return "skipped";
  // Phase 4B — attendance already closed (by hand, or its deadline passed): no poll inviting answers that don't count.
  if (attendanceIsClosed(m)) return "skipped";
  let chatRef = m.telegramChatId;
  if (chatRef) {
    const ok = await prisma.telegramChat.findFirst({ where: { id: chatRef, groupId: ctx.activeGroup.id, disconnectedAt: null }, select: { id: true } });
    if (!ok) chatRef = null;
  }
  if (!chatRef && m.communityId) chatRef = (await communityTelegramChat(ctx.activeGroup.id, m.communityId))?.id ?? null;
  // M11.1 — Telegram is a Pro capability: without it, players answer through the Match Link.
  if (!telegramAllowed) chatRef = null;
  if (!chatRef) {
    // M9.3 — web-only Community: players answer through the Match Link; nothing to post.
    await prisma.matchAutomation.updateMany({ where: { id: automationId, pollPostedAt: null }, data: { pollPostedAt: new Date(), lastError: null } });
    return "link";
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

/**
 * Phase 4B — finalize a passed attendance deadline that is not a first recurring cutoff
 * (a manual Match, or a recurring one reopened with a new deadline): final sync + close
 * the Telegram poll, then mark attendance closed. Never emails anyone (recurring-only).
 */
async function finalizeDeadline(ctx: TenantContext, matchId: string, now: Date): Promise<boolean> {
  const groupId = ctx.activeGroup.id;
  await closeMatchAttendancePolls(groupId, matchId);
  const { count } = await prisma.match.updateMany({ where: { id: matchId, groupId, attendanceClosedAt: null }, data: { attendanceClosedAt: now } });
  return count === 1;
}

/** Attendance summary over the Match's eligible roster — the one shared calculation (src/lib/attendanceSnapshot.ts). */
export async function attendanceSummary(groupId: string, matchId: string): Promise<AttendanceSnapshot> {
  const snapshot = await matchAttendanceSnapshot(groupId, matchId);
  if (!snapshot) throw new Error("Match not found");
  return snapshot;
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
    const share = await prisma.match.findFirstOrThrow({ where: { id: matchId, groupId }, select: { shareVersion: true, group: { select: { visibility: true } } } });
    const linkPath = share.group.visibility === "PRIVATE" ? null : currentMatchLinkPath(matchId, share.shareVersion);
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
        matchLinkPath: linkPath,
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
export type AutomationScope = {
  groupId?: string;
  /** Only this schedule (and its Matches). */
  scheduleId?: string;
  /** Only this Match's steps (requires scheduleId to include a paused schedule). */
  matchId?: string;
  /** Organizer override: include the scoped schedule even while paused. Ignored without scheduleId. */
  includePaused?: boolean;
};

export async function runMatchAutomation(now: Date = new Date(), scope: AutomationScope = {}): Promise<AutomationRun> {
  const includePaused = Boolean(scope.includePaused && scope.scheduleId);
  const scheduleWhere = { ...(scope.scheduleId ? { id: scope.scheduleId } : {}), ...(includePaused ? {} : { isActive: true }) };
  // Automatic runs finalize cutoffs within the catch-up window; an organizer's run for one Match is not limited by it.
  const cutoffFloor = scope.matchId ? undefined : new Date(now.getTime() - CUTOFF_CATCH_UP_MS);
  const run: AutomationRun = { schedules: 0, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, limited: 0, paused: 0, deadlinesClosed: 0, gameDayUpdates: 0, gameDayProblems: 0, errors: [] };
  // Phase 4B — a Run now for ONE manual Match (matchId without scheduleId) never touches schedules.
  const matchOnly = Boolean(scope.matchId && !scope.scheduleId);
  const schedules = matchOnly ? [] : (await prisma.matchSchedule.findMany({
    where: { ...scheduleWhere, group: { isActive: true }, community: { isActive: true }, ...(scope.groupId ? { groupId: scope.groupId } : {}) },
    select: { id: true, groupId: true, communityId: true, venueId: true, createdByUserId: true, timezone: true, weekday: true, startTime: true, pollDaysBefore: true, pollTime: true, cutoffDaysBefore: true, cutoffTime: true },
  })) as ScheduleRow[];
  run.schedules = schedules.length;
  const contexts = new Map<string, TenantContext | null>();
  const ctxFor = async (groupId: string, preferred: string | null) => {
    const key = `${groupId}:${preferred ?? ""}`;
    if (!contexts.has(key)) contexts.set(key, await automationContext(groupId, preferred));
    return contexts.get(key)!;
  };
  // M11.1 — per-Organization plan gate: automation pauses while the Organization has more
  // active schedules than its plan allows (the organizer chooses which one stays); Telegram is Pro.
  // M11.3 — and Telegram automation resumes after an upgrade only for steps due from then on.
  const gates = new Map<string, { paused: boolean; telegram: boolean; since: Date | null }>();
  const gateFor = async (organizationId: string) => {
    if (!gates.has(organizationId)) {
      const [{ limits }, over, since] = await Promise.all([organizationPlan(organizationId, now), schedulesOverLimit(organizationId), telegramEntitledSince(organizationId, now)]);
      gates.set(organizationId, { paused: over.over, telegram: limits.telegram, since });
    }
    return gates.get(organizationId)!;
  };

  // 1 + 2 — create due Matches and post their polls.
  for (const s of schedules) {
    const ctx = await ctxFor(s.groupId, s.createdByUserId);
    if (!ctx) {
      run.errors.push({ scheduleId: s.id, error: "No owner or admin can run this schedule." });
      continue;
    }
    const gate = await gateFor(ctx.organization.id);
    if (gate.paused) {
      run.paused++;
      continue;
    }
    for (const occ of dueForPoll(s, now)) {
      try {
        const ensured = await ensureMatch(s, occ, ctx, now);
        if (!ensured) {
          run.limited++;
          continue;
        }
        const { matchId, automation, created } = ensured;
        if (created) run.created++;
        if (scope.matchId && scope.matchId !== matchId) continue;
        if ((await withMatchLock(matchId, () => stepPoll(ctx, matchId, automation.id, gate.telegram, gate.since))) === "posted") run.pollsPosted++;
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
      match: { status: { not: "CANCELED" }, schedule: scheduleWhere },
    },
    select: { id: true, matchId: true, groupId: true, match: { select: { schedule: { select: { createdByUserId: true } } } } },
  });
  for (const a of pendingPolls) {
    const ctx = await ctxFor(a.groupId, a.match.schedule?.createdByUserId ?? null);
    if (!ctx) continue;
    const gate = await gateFor(ctx.organization.id);
    if (gate.paused) {
      run.paused++;
      continue;
    }
    try {
      if ((await withMatchLock(a.matchId, () => stepPoll(ctx, a.matchId, a.id, gate.telegram, gate.since))) === "posted") run.pollsPosted++;
    } catch (e) {
      run.errors.push({ matchId: a.matchId, error: e instanceof Error ? e.message : "error" });
    }
  }

  // 2c — Phase 4B: Telegram Game Day Updates (manual + recurring). Candidates are only a pre-filter; every
  // condition is re-checked from the database inside deliverGameDayUpdate's lock right before sending.
  const gameDay = await prisma.match.findMany({
    where: {
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.matchId ? { id: scope.matchId } : {}),
      ...(scope.scheduleId ? { scheduleId: scope.scheduleId } : {}),
      status: "SCHEDULED",
      attendanceClosedAt: null,
      attendanceDeadlineAt: { gt: new Date(now.getTime() + MIN_LEFT_MS), lte: new Date(now.getTime() + 12 * 3600_000) },
      telegramPolls: { some: { kind: "ATTENDANCE", isClosed: false } },
      NOT: { deliveries: { some: { eventType: "GAME_DAY_UPDATE_POSTED", status: { in: ["SENT", "UNCERTAIN"] } } } },
      OR: [{ scheduleId: null }, { schedule: scheduleWhere }],
    },
    select: { id: true, groupId: true, scheduleId: true, createdByUserId: true, schedule: { select: { createdByUserId: true } } },
  });
  const enabledByGroup = new Map<string, boolean>();
  for (const m of gameDay) {
    if (!enabledByGroup.has(m.groupId)) enabledByGroup.set(m.groupId, (await readGameDayUpdateSettings(m.groupId)).enabled);
    if (!enabledByGroup.get(m.groupId)) continue;
    const ctx = await ctxFor(m.groupId, m.schedule?.createdByUserId ?? m.createdByUserId ?? null);
    if (!ctx) continue;
    const gate = await gateFor(ctx.organization.id);
    try {
      const r = await deliverGameDayUpdate({
        groupId: m.groupId,
        organizationId: ctx.organization.id,
        matchId: m.id,
        userId: ctx.user.id,
        now,
        planPaused: Boolean(m.scheduleId) && gate.paused,
        counts: async () => (await attendanceSummary(m.groupId, m.id)).counts,
      });
      if (r === "sent") run.gameDayUpdates++;
      else if (r === "failed" || r === "uncertain") run.gameDayProblems++;
    } catch (e) {
      run.errors.push({ matchId: m.id, error: e instanceof Error ? e.message : "error" });
    }
  }

  // 3 + 4 — attendance deadlines and recurring notifications (Phase 4B: driven by Match.attendanceDeadlineAt,
  // the one shared deadline; MatchAutomation.cutoffDueAt never closes anything on its own).
  //   A  recurring first cutoff: deadline passed, cutoff step not done yet (even if closed by hand) → stepCutoff
  //   B  any Match: deadline passed while attendance is still open (manual; recurring reopened with a new deadline)
  //   C  recurring: cutoff done, organizers not yet notified → stepNotify (recurring only, as before)
  // Recurring Matches follow their schedule (paused → skipped, plan pause → skipped). Manual Matches are
  // never COMPLETED-rewritten and never emailed. Automatic runs stay within the catch-up window.
  const windowed = { lte: now, ...(cutoffFloor ? { gte: cutoffFloor } : {}) };
  const due = await prisma.match.findMany({
    where: {
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.matchId ? { id: scope.matchId } : {}),
      ...(scope.scheduleId ? { scheduleId: scope.scheduleId } : {}),
      status: { not: "CANCELED" },
      AND: [
        { OR: [{ automation: { is: null }, status: { not: "COMPLETED" }, scheduleId: null }, { automation: { isNot: null }, schedule: scheduleWhere }] },
        {
          OR: [
            { attendanceDeadlineAt: windowed, automation: { is: { cutoffCompletedAt: null } } },
            { attendanceDeadlineAt: windowed, attendanceClosedAt: null },
            { automation: { is: { cutoffCompletedAt: { not: null }, notifiedAt: null, cutoffDueAt: windowed } } },
          ],
        },
      ],
    },
    select: { id: true, groupId: true, createdByUserId: true, schedule: { select: { createdByUserId: true } }, automation: { select: { id: true } } },
  });
  for (const m of due) {
    const ctx = await ctxFor(m.groupId, m.schedule?.createdByUserId ?? m.createdByUserId ?? null);
    if (!ctx) continue;
    if (m.automation && (await gateFor(ctx.organization.id)).paused) {
      run.paused++;
      continue;
    }
    try {
      const done = await withMatchLock(m.id, async () => {
        // Re-read under the lock: a concurrent deadline change or reopen wins cleanly.
        const fresh = await prisma.match.findFirstOrThrow({
          where: { id: m.id, groupId: m.groupId },
          select: { attendanceClosedAt: true, attendanceDeadlineAt: true, automation: { select: { id: true, cutoffCompletedAt: true, notifiedAt: true } } },
        });
        const passed = fresh.attendanceDeadlineAt !== null && fresh.attendanceDeadlineAt.getTime() <= now.getTime();
        let cut = false;
        let closed = false;
        if (fresh.automation && !fresh.automation.cutoffCompletedAt && passed) cut = await stepCutoff(ctx, m.id, fresh.automation.id, now);
        else if (passed && fresh.attendanceClosedAt === null) closed = await finalizeDeadline(ctx, m.id, now);
        const auto = fresh.automation ? await prisma.matchAutomation.findUniqueOrThrow({ where: { id: fresh.automation.id }, select: { cutoffCompletedAt: true, notifiedAt: true } }) : null;
        const sent = Boolean(auto && auto.cutoffCompletedAt && !auto.notifiedAt && (await stepNotify(ctx, m.id, fresh.automation!.id, now)));
        return { cut, closed, sent };
      });
      if (done?.cut) run.cutoffs++;
      if (done?.closed) run.deadlinesClosed++;
      if (done?.sent) run.notified++;
    } catch (e) {
      run.errors.push({ matchId: m.id, error: e instanceof Error ? e.message : "error" });
    }
  }
  return run;
}

export type OrganizerRunResult = {
  ok: boolean;
  /** Whether the schedule was paused (Run now does not resume it). */
  paused: boolean;
  created: number;
  pollsPosted: number;
  cutoffs: number;
  notified: number;
  /** Phase 4B — Game Day Updates sent in this run. */
  gameDayUpdates?: number;
  /** Organizer-facing problems recorded during this run (no internals). */
  issues: string[];
};

/**
 * M9.2.1 — an organizer's Run now (OWNER/ADMIN; the caller authorizes and
 * resolves the schedule inside the tenant): the SAME engine, scoped to one
 * schedule (optionally one of its Matches), including a paused schedule
 * without resuming it. Nothing that already happened happens again; teams are
 * never generated or published.
 */
export async function organizerRun(groupId: string, scheduleId: string, matchId?: string): Promise<OrganizerRunResult> {
  const startedAt = new Date();
  const schedule = await prisma.matchSchedule.findFirstOrThrow({ where: { id: scheduleId, groupId }, select: { isActive: true, group: { select: { organizationId: true } } } });
  // M11.1 — Run now never bypasses the plan: automation pauses while the Organization has more active
  // schedules than allowed, and on a plan with a schedule limit only ACTIVE schedules run.
  const over = await schedulesOverLimit(schedule.group.organizationId);
  const blocked = over.over
    ? `Automation is paused: your plan includes ${over.limit} active recurring schedule${over.limit === 1 ? "" : "s"}. Choose the schedule to keep active.`
    : !schedule.isActive && over.limit !== null
      ? "On your plan, only active recurring schedules run. Resume this schedule to run it."
      : null;
  if (blocked) return { ok: false, paused: !schedule.isActive, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, issues: [blocked] };
  const run = await runMatchAutomation(startedAt, { groupId, scheduleId, matchId, includePaused: true });
  if (run.errors.length) console.error(`[automation] organizer run finished with ${run.errors.length} error(s): ${JSON.stringify(run.errors)}`);
  const recorded = await prisma.matchAutomation.findMany({
    where: { groupId, match: { scheduleId, ...(matchId ? { id: matchId } : {}) }, lastError: { not: null }, lastErrorAt: { gte: startedAt } },
    select: { lastError: true },
  });
  const issues = [...new Set(recorded.map((r) => r.lastError!))];
  // Phase 2 — occurrences this run could not create because the monthly allowance is used up.
  const skipped = await prisma.matchScheduleSkip.findMany({
    where: { groupId, scheduleId, resolvedAt: null, lastSkippedAt: { gte: startedAt } },
    orderBy: { occurrenceDate: "asc" },
    select: { occurrenceDate: true, monthlyLimit: true },
  });
  for (const k of skipped) issues.push(scheduleSkipMessage(k));
  if (run.gameDayProblems) issues.push(GAME_DAY_PROBLEM);
  if (run.errors.length) issues.push("Something went wrong while running automation. Please try again.");
  return { ok: issues.length === 0, paused: !schedule.isActive, created: run.created, pollsPosted: run.pollsPosted, cutoffs: run.cutoffs, notified: run.notified, gameDayUpdates: run.gameDayUpdates, issues };
}

const GAME_DAY_PROBLEM = "The Game Day Update was not confirmed by Telegram. Check the match page.";

/**
 * Phase 4B — "Run now" for ONE manual Match (no schedule): the same engine scoped to
 * that Match — its Game Day Update and its deadline finalization — never schedules.
 * Lets organizers run what is due without the scheduler (e.g. on Preview).
 */
export async function organizerRunMatch(groupId: string, matchId: string): Promise<OrganizerRunResult> {
  const run = await runMatchAutomation(new Date(), { groupId, matchId });
  if (run.errors.length) console.error(`[automation] match run finished with ${run.errors.length} error(s): ${JSON.stringify(run.errors)}`);
  const issues = [...(run.gameDayProblems ? [GAME_DAY_PROBLEM] : []), ...(run.errors.length ? ["Something went wrong while running automation. Please try again."] : [])];
  return { ok: issues.length === 0, paused: false, created: 0, pollsPosted: 0, cutoffs: run.cutoffs + run.deadlinesClosed, notified: run.notified, gameDayUpdates: run.gameDayUpdates, issues };
}
