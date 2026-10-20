import type { NoticeResult } from "@/lib/pollClosure";
import { closeMatchAttendance } from "@/lib/attendanceClosure";

/**
 * M9.2 — close a Match's open Telegram ATTENDANCE poll(s). M12B: every close path
 * (Close attendance, Close Telegram poll, the deadline, Post teams to Telegram)
 * runs the ONE closure in src/lib/attendanceClosure.ts; this module keeps the
 * result shape and messages. (Website Publish does not close anything.)
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
 * M12B — compatibility wrapper over the unified closure (src/lib/attendanceClosure.ts):
 * closing a Match's Telegram poll now ALSO closes its attendance (one workflow), and
 * `notify` sends the one-time notice for every verifiably closed poll, whether or
 * not teams were posted (once per poll, ever).
 */
export async function closeMatchAttendancePolls(groupId: string, matchId: string, notify?: { userId: string | null }, now?: Date): Promise<PollCloseResult> {
  const r = await closeMatchAttendance({ groupId, matchId, userId: notify?.userId ?? null, notify: Boolean(notify), now });
  if (!r) return { status: "no_poll", closed: 0, open: 0 };
  const closed = r.polls.filter((p) => p.close === "closed_now" || p.close === "already_closed_on_telegram").length;
  const open = r.polls.filter((p) => p.close === "close_failed" || p.close === "close_uncertain" || p.close === "missing_message_id").length;
  const notices = r.polls.map((p) => p.notice).filter((n): n is NoticeResult => n !== "not_requested" && n !== "not_closed");
  return { status: r.status, closed, open, ...(notify ? { notices } : {}) };
}

export const POLL_CLOSE_MESSAGE: Record<PollCloseStatus, string | null> = {
  no_poll: null,
  already_closed: null,
  closed: "The attendance poll in Telegram was closed.",
  failed: "Telegram refused to close the attendance poll. It is still open — close it again from the match.",
  uncertain: "Telegram didn't confirm that the attendance poll was closed. Check the group; closing it again is safe.",
};
