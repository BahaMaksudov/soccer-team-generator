import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { callTelegram, TelegramAmbiguousError, TelegramApiRejectionError } from "@/lib/telegramApi";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";
import { resolvePollDisplayDate } from "@/lib/telegramFormat";
import { organizationPlan } from "@/lib/entitlements";

/**
 * Telegram publishing — closing ONE attendance poll, and the one-time
 * "✅ Poll is closed for M/D/YY" notice (restored from the Phase 1 publish
 * flow, now with a durable delivery record).
 *
 * stopAttendancePoll(): stopPoll for one poll; the poll is marked closed ONLY
 * after a verified close (Telegram accepted it, or Telegram says it was
 * already closed). Outcomes are never merged: a definite refusal is
 * close_failed, a timeout / network problem is close_uncertain (the poll may or
 * may not be closed — nothing is claimed; closing again is safe because
 * stopPoll is idempotent).
 *
 * The notice — at most ONE per poll, across requests and server instances:
 * the decision + reservation (a SENDING MessageDelivery row, eventType
 * POLL_CLOSED_NOTICE) run in one transaction holding the database advisory
 * lock of that poll ("delivery:TELEGRAM:<pollId>", the lock the teams post
 * already takes). Any later request sees the row (SENDING / SENT / FAILED /
 * UNCERTAIN) and does not send. Sent only right after a verified close by
 * "Post teams to Telegram" or its "Close Telegram poll" recovery — never for a
 * poll that was already closed locally (deadline / an earlier action), never
 * after an unclear close. FAILED (Telegram definitely refused) may be retried
 * explicitly; UNCERTAIN / an abandoned SENDING is never re-sent — the organizer
 * may only mark it as sent after checking the chat.
 */
export type StopOutcome = "closed_now" | "already_closed_locally" | "already_closed_on_telegram" | "missing_message_id" | "close_failed" | "close_uncertain";
export type PollToClose = { pollId: string; chatId: bigint; messageId: bigint | null; isClosed: boolean };

/** Closure verified (now or already on Telegram) — the only outcomes that mark the poll closed. */
export const isVerifiedClose = (o: StopOutcome) => o === "closed_now" || o === "already_closed_on_telegram";

export async function stopAttendancePoll(groupId: string, poll: PollToClose): Promise<StopOutcome> {
  if (poll.isClosed) return "already_closed_locally";
  if (poll.messageId == null) return "missing_message_id";
  let outcome: StopOutcome;
  try {
    await callTelegram("stopPoll", { chat_id: poll.chatId.toString(), message_id: Number(poll.messageId) });
    outcome = "closed_now";
  } catch (e) {
    if (e instanceof TelegramApiRejectionError) {
      outcome = (e.description ?? e.message).toLowerCase().includes("already been closed") ? "already_closed_on_telegram" : "close_failed";
    } else {
      outcome = "close_uncertain"; // TelegramAmbiguousError (timeout / network / unreadable) or anything unexpected
    }
  }
  if (isVerifiedClose(outcome)) {
    await prisma.telegramPoll.updateMany({ where: { pollId: poll.pollId, groupId }, data: { isClosed: true } }).catch(() => {
      // Telegram is the source of truth; the next attempt reconciles ("already been closed").
    });
  }
  return outcome;
}

// ---------------------------------------------------------------- the notice
const EVENT = "POLL_CLOSED_NOTICE" as const;
const CHANNEL = "TELEGRAM" as const;
const lockPoll = (tx: Prisma.TransactionClient, pollId: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"delivery:TELEGRAM:" + pollId}))`;

export const pollClosedNoticeText = (displayDate: string) => `✅ Poll is closed for ${displayDate}`;

export type NoticeState = "none" | "sending" | "sent" | "failed" | "uncertain";
type NoticeRow = { id: string; status: "SENDING" | "SENT" | "FAILED" | "UNCERTAIN"; claimedAt: Date };

const stateOf = (row: NoticeRow | null, now: Date): NoticeState =>
  !row ? "none" : row.status === "SENT" ? "sent" : row.status === "FAILED" ? "failed" : row.status === "UNCERTAIN" ? "uncertain" : now.getTime() - row.claimedAt.getTime() > STALE_SENDING_MS ? "uncertain" : "sending";

async function latestNotice(db: Prisma.TransactionClient | typeof prisma, groupId: string, pollId: string): Promise<NoticeRow | null> {
  return db.messageDelivery.findFirst({
    where: { groupId, telegramPollId: pollId, channel: CHANNEL, eventType: EVENT },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, claimedAt: true },
  });
}

export async function pollClosedNoticeState(groupId: string, pollId: string, now = new Date()): Promise<{ state: NoticeState; deliveryId: string | null }> {
  const row = await latestNotice(prisma, groupId, pollId);
  return { state: stateOf(row, now), deliveryId: row?.id ?? null };
}

export type NoticeResult = "sent" | "failed" | "uncertain" | "exists" | "not_in_plan";

/** M11.3 — whether the Group's Organization may send Telegram messages right now (effective plan, real clock). */
export async function groupTelegramAllowed(groupId: string, now: Date = new Date()): Promise<boolean> {
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { organizationId: true } });
  return group ? (await organizationPlan(group.organizationId, now)).limits.telegram : false;
}

/**
 * Send the notice for this poll — once. `retryFailed` (explicit organizer
 * action only) re-sends a FAILED one; anything else that exists is left alone.
 */
export async function sendPollClosedNotice(
  p: { groupId: string; matchId: string | null; poll: { pollId: string; chatId: bigint }; displayDate: string; userId: string | null },
  opts: { retryFailed?: boolean } = {}
): Promise<NoticeResult> {
  // M11.3 — the notice is a NEW Telegram message: Pro only. On Free a poll can still be
  // closed (stopPoll), but nothing is announced and no delivery record is created.
  if (!(await groupTelegramAllowed(p.groupId))) return "not_in_plan";
  const text = pollClosedNoticeText(p.displayDate);
  const reserved = await prisma.$transaction(async (tx) => {
    await lockPoll(tx, p.poll.pollId);
    const row = await latestNotice(tx, p.groupId, p.poll.pollId);
    const now = new Date();
    if (row && !(row.status === "FAILED" && opts.retryFailed)) return null;
    const data = { destination: p.poll.chatId.toString(), contentHash: contentHashOf(text), status: "SENDING" as const, claimedAt: now };
    if (row) {
      await tx.messageDelivery.update({ where: { id: row.id }, data: { ...data, attempts: { increment: 1 }, failedAt: null, failureCode: null, failureDetail: null } });
      return row.id;
    }
    const created = await tx.messageDelivery.create({
      data: { ...data, groupId: p.groupId, matchId: p.matchId, telegramPollId: p.poll.pollId, eventType: EVENT, channel: CHANNEL, createdByUserId: p.userId },
      select: { id: true },
    });
    return created.id;
  });
  if (!reserved) return "exists";

  try {
    const sent = (await callTelegram("sendMessage", { chat_id: p.poll.chatId.toString(), text })) as { message_id?: unknown } | null;
    const providerMessageId = typeof sent?.message_id === "number" || typeof sent?.message_id === "string" ? String(sent.message_id) : null;
    if (!providerMessageId) {
      await prisma.messageDelivery.updateMany({ where: { id: reserved, status: "SENDING" }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: "UNREADABLE_RESPONSE" } });
      return "uncertain";
    }
    await prisma.messageDelivery.updateMany({ where: { id: reserved, status: "SENDING" }, data: { status: "SENT", sentAt: new Date(), providerMessageId } });
    return "sent";
  } catch (e) {
    if (e instanceof TelegramApiRejectionError) {
      await prisma.messageDelivery.updateMany({ where: { id: reserved, status: "SENDING" }, data: { status: "FAILED", failedAt: new Date(), failureCode: "TELEGRAM_REJECTED", failureDetail: (e.description ?? e.message).slice(0, 200) } });
      return "failed";
    }
    const code = e instanceof TelegramAmbiguousError ? (e.reason === "timeout" ? "TIMEOUT" : e.reason === "network" ? "NETWORK" : "UNREADABLE_RESPONSE") : "UNKNOWN";
    await prisma.messageDelivery.updateMany({ where: { id: reserved, status: "SENDING" }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: code } }).catch(() => {});
    return "uncertain";
  }
}

/** Organizer recovery: an UNCERTAIN (or abandoned SENDING) notice IS in the chat → SENT (MARKED_SENT audit). Never sends. */
export async function markPollClosedNoticeSent(p: { groupId: string; pollId: string; deliveryId: string; userId: string }, now = new Date()): Promise<"ok" | "not_latest" | "not_uncertain"> {
  return prisma.$transaction(async (tx) => {
    await lockPoll(tx, p.pollId);
    const row = await latestNotice(tx, p.groupId, p.pollId);
    if (!row || row.id !== p.deliveryId) return "not_latest";
    if (stateOf(row, now) !== "uncertain") return "not_uncertain";
    await tx.messageDelivery.update({ where: { id: row.id }, data: { status: "SENT", sentAt: now, resolution: "MARKED_SENT", resolvedAt: now, resolvedByUserId: p.userId } });
    return "ok";
  });
}

/** Whether the teams were posted to Telegram for this poll (any SENT TEAMS_PUBLISHED delivery). */
export async function teamsPostedToPoll(groupId: string, pollId: string): Promise<boolean> {
  return (await prisma.messageDelivery.count({ where: { groupId, telegramPollId: pollId, channel: CHANNEL, eventType: "TEAMS_PUBLISHED", status: "SENT" } })) > 0;
}

/**
 * Organizer recovery for the closure notice of ONE match (OWNER/ADMIN; callers
 * authorize and pass the URL-resolved Group + Match):
 *   retry     — only when the notice is FAILED (Telegram definitely refused: nothing posted)
 *   mark_sent — only when it is UNCERTAIN / an abandoned SENDING and the organizer found it in the chat
 * Never sends for any other state (SENT / SENDING / UNCERTAIN are not re-sent).
 */
export async function recoverPollClosedNotice(p: { groupId: string; matchId: string; deliveryId: string; action: "retry" | "mark_sent"; userId: string }): Promise<{ ok: boolean; result: string }> {
  const row = await prisma.messageDelivery.findFirst({
    where: { id: p.deliveryId, groupId: p.groupId, matchId: p.matchId, channel: CHANNEL, eventType: EVENT },
    select: { telegramPollId: true },
  });
  if (!row?.telegramPollId) return { ok: false, result: "not_found" };
  const poll = await prisma.telegramPoll.findFirst({ where: { pollId: row.telegramPollId, groupId: p.groupId, matchId: p.matchId }, select: { pollId: true, chatId: true, question: true, pollDate: true, isClosed: true } });
  if (!poll) return { ok: false, result: "not_found" };
  if (p.action === "mark_sent") {
    const r = await markPollClosedNoticeSent({ groupId: p.groupId, pollId: poll.pollId, deliveryId: p.deliveryId, userId: p.userId });
    return { ok: r === "ok", result: r === "ok" ? "marked_sent" : r };
  }
  const { state, deliveryId } = await pollClosedNoticeState(p.groupId, poll.pollId);
  if (state !== "failed" || deliveryId !== p.deliveryId) return { ok: false, result: "not_failed" };
  if (!poll.isClosed) return { ok: false, result: "poll_not_closed" }; // never announce a poll that isn't verifiably closed
  const r = await sendPollClosedNotice({ groupId: p.groupId, matchId: p.matchId, poll, displayDate: resolvePollDisplayDate(poll), userId: p.userId }, { retryFailed: true });
  return { ok: r === "sent", result: r };
}
