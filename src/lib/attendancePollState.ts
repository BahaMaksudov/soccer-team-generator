import { prisma } from "@/lib/prisma";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { attendancePollContent } from "@/lib/messaging";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";

/**
 * Telegram publishing — the attendance poll's PERSISTED posting state for ONE
 * chat (the Match's selected Telegram group), read from its MessageDelivery
 * records (eventType ATTENDANCE_POLL_POSTED, destination = that chat). The
 * Match Workspace button follows it; the posting itself (src/lib/
 * telegramAttendance.ts) enforces the same rules server-side under the per-match
 * lock, so a stale page can never post twice.
 *
 *   not_posted       nothing for this chat yet
 *   posting          a reservation in progress (≤ STALE_SENDING_MS old)
 *   posted           SENT with the CURRENT poll content
 *   details_changed  SENT, but the match's date / time / location changed since
 *   failed           Telegram definitively refused (nothing posted) — retry is safe
 *   uncertain        timeout / unreadable reply / abandoned reservation — check Telegram
 */
export const POLL_EVENT = "ATTENDANCE_POLL_POSTED" as const;
const CHANNEL = "TELEGRAM" as const;

export type PollPostState = "not_posted" | "posting" | "posted" | "details_changed" | "failed" | "uncertain";

/** The poll content and its hash for one destination (the hash the posting compares). */
export function attendancePollFor(match: { date: Date; startTime: string | null; locationName: string | null }, destination: string) {
  const content = attendancePollContent({ date: formatYMDFromDate(match.date), startTime: match.startTime, locationName: match.locationName });
  return { content, contentHash: contentHashOf(JSON.stringify({ destination, question: content.question, options: content.options })) };
}

export function pollPostStateOf(latest: { status: string; contentHash: string; claimedAt: Date } | null, currentHash: string, now: Date): PollPostState {
  if (!latest) return "not_posted";
  if (latest.status === "SENT") return latest.contentHash === currentHash ? "posted" : "details_changed";
  if (latest.status === "FAILED") return "failed";
  if (latest.status === "UNCERTAIN") return "uncertain";
  return now.getTime() - latest.claimedAt.getTime() > STALE_SENDING_MS ? "uncertain" : "posting";
}

export type PollPostView = { state: PollPostState; at: string | null; otherChats: string[] };

/** State for the selected chat + the titles of OTHER chats that already have an attendance poll for this match. */
export async function attendancePollPostView(
  groupId: string,
  match: { id: string; date: Date; startTime: string | null; locationName: string | null },
  chat: { chatId: bigint },
  now = new Date()
): Promise<PollPostView> {
  const destination = chat.chatId.toString();
  const [latest, others] = await Promise.all([
    prisma.messageDelivery.findFirst({
      where: { matchId: match.id, groupId, eventType: POLL_EVENT, channel: CHANNEL, destination },
      orderBy: { createdAt: "desc" },
      select: { status: true, contentHash: true, claimedAt: true, sentAt: true },
    }),
    otherChatPollTitles(groupId, match.id, chat.chatId),
  ]);
  const state = pollPostStateOf(latest, attendancePollFor(match, destination).contentHash, now);
  return { state, at: state === "posted" || state === "details_changed" ? (latest?.sentAt?.toISOString() ?? null) : null, otherChats: others };
}

/** Titles of the OTHER Telegram groups (of this Group) where this match already has an attendance poll. */
export async function otherChatPollTitles(groupId: string, matchId: string, chatId: bigint): Promise<string[]> {
  const polls = await prisma.telegramPoll.findMany({ where: { matchId, groupId, kind: "ATTENDANCE", chatId: { not: chatId } }, select: { chatId: true }, distinct: ["chatId"] });
  if (!polls.length) return [];
  const chats = await prisma.telegramChat.findMany({ where: { groupId, chatId: { in: polls.map((p) => p.chatId) } }, select: { chatId: true, title: true } });
  return polls.map((p) => chats.find((c) => c.chatId === p.chatId)?.title?.trim() || "another Telegram group");
}
