import { prisma } from "@/lib/prisma";
import { callTelegram, TelegramAmbiguousError, TelegramApiRejectionError } from "@/lib/telegramApi";
import { syncMatchAttendanceAnswers } from "@/lib/telegramAttendance";

/**
 * M9.2 — close a Match's open Telegram ATTENDANCE poll(s) (restores the
 * pre-2D.6D.5E.5 behavior "publishing teams closes the attendance poll", now
 * as server-side orchestration; also used at the automation cutoff).
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
 * Nothing here sends a message, and nothing here changes teams. No auth —
 * callers authorize; every query is scoped by groupId.
 */
export type PollCloseStatus = "no_poll" | "already_closed" | "closed" | "failed" | "uncertain";
export type PollCloseResult = { status: PollCloseStatus; closed: number; open: number };

export async function closeMatchAttendancePolls(groupId: string, matchId: string): Promise<PollCloseResult> {
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { attendanceClosedAt: true } });
  if (!match) return { status: "no_poll", closed: 0, open: 0 };
  const polls = await prisma.telegramPoll.findMany({
    where: { matchId, groupId, kind: "ATTENDANCE" },
    select: { pollId: true, chatId: true, messageId: true, isClosed: true },
  });
  if (polls.length === 0) return { status: "no_poll", closed: 0, open: 0 };
  const open = polls.filter((p) => !p.isClosed);
  if (open.length === 0) return { status: "already_closed", closed: 0, open: 0 };

  if (!match.attendanceClosedAt) await syncMatchAttendanceAnswers(groupId, matchId);

  let closed = 0;
  let worst: PollCloseStatus = "closed";
  for (const poll of open) {
    if (poll.messageId == null) {
      worst = "failed"; // cannot be closed through Telegram without its message id
      continue;
    }
    try {
      await callTelegram("stopPoll", { chat_id: poll.chatId.toString(), message_id: Number(poll.messageId) });
    } catch (e) {
      const alreadyClosed = e instanceof TelegramApiRejectionError && (e.description ?? e.message).toLowerCase().includes("already been closed");
      if (!alreadyClosed) {
        // A definite refusal is "failed"; anything ambiguous (timeout / network / unreadable) is "uncertain".
        if (e instanceof TelegramAmbiguousError) worst = "uncertain";
        else if (worst !== "uncertain") worst = "failed";
        continue;
      }
    }
    await prisma.telegramPoll.updateMany({ where: { pollId: poll.pollId, groupId }, data: { isClosed: true } });
    closed++;
  }
  return { status: worst, closed, open: open.length - closed };
}

export const POLL_CLOSE_MESSAGE: Record<PollCloseStatus, string | null> = {
  no_poll: null,
  already_closed: null,
  closed: "The attendance poll in Telegram was closed.",
  failed: "Telegram refused to close the attendance poll. It is still open — close it again from the match.",
  uncertain: "Telegram didn't confirm that the attendance poll was closed. Check the group; closing it again is safe.",
};
