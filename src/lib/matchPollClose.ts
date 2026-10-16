import { prisma } from "@/lib/prisma";
import { isVerifiedClose, sendPollClosedNotice, stopAttendancePoll, teamsPostedToPoll, type NoticeResult } from "@/lib/pollClosure";
import { resolvePollDisplayDate } from "@/lib/telegramFormat";
import { syncMatchAttendanceAnswers } from "@/lib/telegramAttendance";

/**
 * M9.2 — close a Match's open Telegram ATTENDANCE poll(s): used at the
 * attendance deadline / automation cutoff and by the organizer's "Close
 * Telegram poll" action. (Website Publish no longer closes polls — "Post teams
 * to Telegram" closes the poll it posts to.)
 *
 * Order: (1) if Team Balance Pro attendance is still open, replay the stored
 * answers (final sync, same mapping as the webhook); (2) stopPoll each open
 * poll. Telegram's stopPoll is idempotent ("poll has already been closed" is
 * treated as closed), so a retry is always safe. Outcomes are reported, never
 * hidden:
 *   closed          — every open poll is now closed (or there was nothing open
 *                     but at least one poll exists: `already_closed`);
 *   no_poll         — the Match has no attendance poll;
 *   failed          — Telegram definitively refused (poll left open locally);
 *   uncertain       — Telegram did not answer clearly (timeout/network): the
 *                     poll may or may not be closed; left open locally, retry safe.
 * Nothing here changes teams. It sends a message only with `notify` (the
 * one-time closure notice, see below). No auth — callers authorize; every
 * query is scoped by groupId.
 */
export type PollCloseStatus = "no_poll" | "already_closed" | "closed" | "failed" | "uncertain";
export type PollCloseResult = { status: PollCloseStatus; closed: number; open: number; notices?: NoticeResult[] };

/**
 * `notify` (organizer "Close Telegram poll" recovery only): after a VERIFIED
 * close of a poll whose teams were already posted to Telegram, send its
 * one-time "Poll is closed" notice (never for the deadline step, never after an
 * unclear close, never twice — see src/lib/pollClosure.ts).
 */
export async function closeMatchAttendancePolls(groupId: string, matchId: string, notify?: { userId: string }): Promise<PollCloseResult> {
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { attendanceClosedAt: true } });
  if (!match) return { status: "no_poll", closed: 0, open: 0 };
  const polls = await prisma.telegramPoll.findMany({
    where: { matchId, groupId, kind: "ATTENDANCE" },
    select: { pollId: true, chatId: true, messageId: true, isClosed: true, question: true, pollDate: true },
  });
  if (polls.length === 0) return { status: "no_poll", closed: 0, open: 0 };
  const open = polls.filter((p) => !p.isClosed);
  if (open.length === 0) return { status: "already_closed", closed: 0, open: 0 };

  if (!match.attendanceClosedAt) await syncMatchAttendanceAnswers(groupId, matchId);

  let closed = 0;
  let worst: PollCloseStatus = "closed";
  const notices: NoticeResult[] = [];
  for (const poll of open) {
    const outcome = await stopAttendancePoll(groupId, poll);
    if (outcome === "close_uncertain") worst = "uncertain";
    else if ((outcome === "close_failed" || outcome === "missing_message_id") && worst !== "uncertain") worst = "failed";
    if (!isVerifiedClose(outcome)) continue;
    closed++;
    if (notify && (await teamsPostedToPoll(groupId, poll.pollId))) {
      notices.push(await sendPollClosedNotice({ groupId, matchId, poll, displayDate: resolvePollDisplayDate(poll), userId: notify.userId }));
    }
  }
  return { status: worst, closed, open: open.length - closed, ...(notify ? { notices } : {}) };
}

export const POLL_CLOSE_MESSAGE: Record<PollCloseStatus, string | null> = {
  no_poll: null,
  already_closed: null,
  closed: "The attendance poll in Telegram was closed.",
  failed: "Telegram refused to close the attendance poll. It is still open — close it again from the match.",
  uncertain: "Telegram didn't confirm that the attendance poll was closed. Check the group; closing it again is safe.",
};
