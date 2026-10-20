import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncMatchAttendanceAnswers } from "@/lib/telegramAttendance";
import { groupTelegramAllowed, isVerifiedClose, sendPollClosedNotice, stopAttendancePoll, type NoticeResult, type StopOutcome } from "@/lib/pollClosure";
import { resolvePollDisplayDate } from "@/lib/telegramFormat";

/**
 * M12B — ONE attendance workflow per Match, and ONE way to close it.
 *
 * Workflow (attendanceMode):
 *   telegram — the Match has a Telegram attendance poll, or a connected Telegram
 *              group is selected for it and the organization may use Telegram.
 *              Players vote in the poll; no personal links.
 *   web      — everything else: players answer through personal attendance links
 *              (organizers distribute them); organizers can always override.
 *
 * Closing (closeMatchAttendance) — used by "Close attendance", "Close Telegram
 * poll", the attendance deadline (automation) and "Post teams to Telegram":
 *   1. final sync of stored Telegram answers while attendance is still open;
 *   2. attendance closed in Team Balance Pro (attendanceClosedAt, idempotent);
 *   3. every open attendance poll of the Match stopped (stopPoll, idempotent) —
 *      NO database transaction is held during Telegram calls;
 *   4. the one-time "✅ Poll is closed" notice for each poll that is VERIFIABLY
 *      closed (now, earlier, or found closed on Telegram) — independent of
 *      whether teams were published. One per poll, ever: the existing
 *      POLL_CLOSED_NOTICE delivery record + per-poll lock dedupe it, so
 *      publishing teams afterwards never sends a second one. Never after an
 *      unclear or refused stop (the poll stays open locally; closing again is
 *      safe). Skipped without Telegram in the plan ("not_in_plan" — Free /
 *      expired trials can still CLOSE existing polls). LEGACY / Pro unchanged.
 *   The deadline (automation) sends the notice only when ATTENDANCE_DEADLINE_NOTICE
 *   is "on" (new automatic messaging — OFF until approved).
 */
export type AttendanceMode = "telegram" | "web";

/**
 * `db` lets a caller decide INSIDE its write transaction (M13A): after locking the
 * Match row (lockMatchForAnswer) a concurrent poll insert / chat assignment can't
 * slip in between this decision and the answer it guards.
 */
export async function attendanceMode(groupId: string, matchId: string, db: Prisma.TransactionClient = prisma): Promise<AttendanceMode | null> {
  const m = await db.match.findFirst({
    where: { id: matchId, groupId },
    select: { telegramChat: { select: { disconnectedAt: true } }, _count: { select: { telegramPolls: { where: { kind: "ATTENDANCE" } } } } },
  });
  if (!m) return null;
  if (m._count.telegramPolls > 0) return "telegram";
  if (m.telegramChat && m.telegramChat.disconnectedAt === null && (await groupTelegramAllowed(groupId, new Date(), db))) return "telegram";
  return "web";
}

/**
 * M13A — lock everything attendanceMode() depends on before a website answer, so
 * a switch to Telegram-managed attendance either commits first (and the check in
 * the same transaction sees it) or waits until the answer is committed:
 *   - the Match row, FOR UPDATE: inserting a TelegramPoll for the Match takes
 *     FOR KEY SHARE on it (foreign key) and assigning a Telegram chat updates it;
 *   - its Telegram chat row, FOR SHARE: reconnecting a disconnected chat
 *     (disconnectedAt → null) updates that row;
 *   - its Organization row, FOR SHARE (only when a chat is assigned — the plan
 *     matters only then): a plan change / trial / Stripe upgrade updates that row.
 * Lock order is always Match → TelegramChat → Organization; none of those other
 * writers touches a Match row, so no deadlock cycle. FOR SHARE never blocks
 * other answers. (A trial EXPIRING needs no write and only moves a match from
 * Telegram to web — never towards a competing workflow.)
 */
export async function lockMatchForAnswer(tx: Prisma.TransactionClient, matchId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 AS locked FROM "TelegramChat" c JOIN "Match" m ON m."telegramChatId" = c."id" WHERE m."id" = ${matchId} FOR SHARE OF c`;
  await tx.$queryRaw`SELECT 1 AS locked FROM "Organization" o JOIN "Group" g ON g."organizationId" = o."id" JOIN "Match" m ON m."groupId" = g."id" WHERE m."id" = ${matchId} AND m."telegramChatId" IS NOT NULL FOR SHARE OF o`;
}

export function deadlineNoticeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ATTENDANCE_DEADLINE_NOTICE?.trim().toLowerCase() === "on";
}

export type PollClosure = { pollId: string; close: StopOutcome; notice: NoticeResult | "not_requested" | "not_closed" };
export type AggregateClose = "no_poll" | "already_closed" | "closed" | "failed" | "uncertain";
export type CloseAttendanceResult = { attendance: "closed_now" | "already_closed"; status: AggregateClose; polls: PollClosure[] };

const NOTICE_ELIGIBLE: readonly StopOutcome[] = ["closed_now", "already_closed_on_telegram", "already_closed_locally"];

/**
 * Close one attendance poll and (optionally) announce it once. Shared with
 * "Post teams to Telegram" for polls that belong to no Match.
 */
export async function closePollOnce(
  groupId: string,
  poll: { pollId: string; chatId: bigint; messageId: bigint | null; isClosed: boolean; question: string; pollDate: Date | null; matchId: string | null },
  notify: { userId: string | null } | null
): Promise<PollClosure> {
  const close = await stopAttendancePoll(groupId, poll);
  if (!notify) return { pollId: poll.pollId, close, notice: "not_requested" };
  if (!NOTICE_ELIGIBLE.includes(close)) return { pollId: poll.pollId, close, notice: "not_closed" };
  // "already_closed_locally" was a verified close earlier (only verified closes mark a poll closed).
  const notice = await sendPollClosedNotice({ groupId, matchId: poll.matchId, poll, displayDate: resolvePollDisplayDate(poll), userId: notify.userId }).catch(() => "uncertain" as const);
  return { pollId: poll.pollId, close, notice };
}

export async function closeMatchAttendance(params: { groupId: string; matchId: string; userId: string | null; notify: boolean; now?: Date }): Promise<CloseAttendanceResult | null> {
  const { groupId, matchId } = params;
  const now = params.now ?? new Date();
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { attendanceClosedAt: true } });
  if (!match) return null;

  // 1 — replay stored Telegram answers while Team Balance Pro attendance is still open
  // (answers given before the deadline still count; the sync applies the deadline rule per answer).
  if (!match.attendanceClosedAt) await syncMatchAttendanceAnswers(groupId, matchId);

  // 2 — close attendance (idempotent; the first close keeps its instant).
  const { count } = await prisma.match.updateMany({ where: { id: matchId, groupId, attendanceClosedAt: null }, data: { attendanceClosedAt: now } });

  // 3 + 4 — every attendance poll of the Match (no transaction held around Telegram).
  const polls = await prisma.telegramPoll.findMany({
    where: { matchId, groupId, kind: "ATTENDANCE" },
    orderBy: { createdAt: "asc" },
    select: { pollId: true, chatId: true, messageId: true, isClosed: true, question: true, pollDate: true, matchId: true },
  });
  const results: PollClosure[] = [];
  for (const poll of polls) results.push(await closePollOnce(groupId, poll, params.notify ? { userId: params.userId } : null));

  let status: AggregateClose;
  if (polls.length === 0) status = "no_poll";
  else if (results.some((r) => r.close === "close_uncertain")) status = "uncertain";
  else if (results.some((r) => r.close === "close_failed" || r.close === "missing_message_id")) status = "failed";
  else if (results.every((r) => r.close === "already_closed_locally")) status = "already_closed";
  else status = "closed";
  return { attendance: count === 1 ? "closed_now" : "already_closed", status, polls: results };
}

/** Organizer-facing summary of a close (no ids, no provider details). */
export function closeSummary(r: CloseAttendanceResult): string {
  const parts = [r.attendance === "closed_now" ? "Attendance closed." : "Attendance was already closed."];
  if (r.status === "closed") parts.push("The Telegram poll was closed.");
  if (r.status === "uncertain") parts.push("Telegram didn't confirm that the poll was closed — it may still be open. Closing again is safe.");
  if (r.status === "failed") parts.push("Telegram refused to close the poll — it is still open. Try again.");
  const notices = r.polls.map((p) => p.notice);
  if (notices.includes("sent")) parts.push("Closure notice sent.");
  else if (notices.includes("failed")) parts.push("Telegram refused the closure notice — you can retry it.");
  else if (notices.includes("uncertain")) parts.push("The closure notice wasn't confirmed — check the group; it won't be sent again automatically.");
  else if (notices.includes("not_in_plan")) parts.push("No closure notice was posted — Telegram messages are part of Pro.");
  return parts.join(" ");
}
