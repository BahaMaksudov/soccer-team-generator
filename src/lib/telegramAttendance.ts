import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { attendancePollSchema, zodErrorResponse } from "@/lib/validation";
import { attendanceFromTelegramOptions, recordParticipantResponse } from "@/lib/attendance";
import { attendancePollContent, renderTelegramPoll } from "@/lib/messaging";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { findGroupMatch } from "@/lib/matches";

/**
 * M9-A — Telegram adapter for channel-neutral Match attendance.
 *
 *  - applyTelegramAttendanceAnswer(): the ONE mapping from a Telegram poll
 *    answer to AttendanceResponse, used by the webhook (live) and by the
 *    explicit sync (recovery). Only voters linked in the poll's Group
 *    (TelegramUserLink) are recorded; unlinked voters stay provider-only
 *    (TelegramPollAnswer) and are never written into core attendance.
 *  - postAttendancePoll(): the explicit, OWNER/ADMIN "Post poll to
 *    Telegram". Idempotent via MessageDelivery (reserve → send → finalize,
 *    under a per-Match lock): same content already SENT is a no-op, changed
 *    content needs "post_updated", UNCERTAIN is never retried blindly.
 */

const EVENT = "ATTENDANCE_POLL_POSTED" as const;
const CHANNEL = "TELEGRAM" as const;

/** Webhook + sync: record one Telegram answer for a Match-linked attendance poll. */
export async function applyTelegramAttendanceAnswer(
  tx: Prisma.TransactionClient,
  input: { matchId: string; groupId: string; telegramUserId: bigint; optionIds: unknown; at: Date }
): Promise<"recorded" | "stale" | "unlinked"> {
  const link = await tx.telegramUserLink.findUnique({
    where: { groupId_userId: { groupId: input.groupId, userId: input.telegramUserId } },
    select: { playerId: true },
  });
  if (!link) return "unlinked";
  // Defense in depth: the linked Player must belong to the poll's Group.
  const player = await tx.player.findFirst({ where: { id: link.playerId, groupId: input.groupId }, select: { id: true } });
  if (!player) return "unlinked";
  return recordParticipantResponse(tx, {
    matchId: input.matchId,
    groupId: input.groupId,
    playerId: player.id,
    status: attendanceFromTelegramOptions(input.optionIds),
    source: "TELEGRAM",
    at: input.at,
  });
}

/** Explicit recovery sync from stored answers of the Match's attendance polls (same mapping as the webhook). */
export async function syncTelegramAttendance(context: TenantContext, matchId: string): Promise<NextResponse> {
  const groupId = context.activeGroup.id;
  const match = await findGroupMatch(context, matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const polls = await prisma.telegramPoll.findMany({ where: { matchId, groupId, kind: "ATTENDANCE" }, select: { pollId: true } });
  const answers = await prisma.telegramPollAnswer.findMany({
    where: { groupId, pollId: { in: polls.map((p) => p.pollId) } },
    orderBy: { updatedAt: "asc" },
    select: { userId: true, optionIdsJson: true, updatedAt: true },
  });
  const tally = { recorded: 0, stale: 0, unlinked: 0 };
  for (const a of answers) {
    let optionIds: unknown = [];
    try {
      optionIds = JSON.parse(a.optionIdsJson);
    } catch {
      optionIds = [];
    }
    const r = await prisma.$transaction((tx) =>
      applyTelegramAttendanceAnswer(tx, { matchId, groupId, telegramUserId: a.userId, optionIds, at: a.updatedAt })
    );
    tally[r]++;
  }
  // Counts only — never Telegram identities.
  return NextResponse.json({ ok: true, polls: polls.length, ...tally });
}

type PollDelivery = { id: string; status: "SENDING" | "SENT" | "FAILED" | "UNCERTAIN"; contentHash: string; claimedAt: Date };

/** Explicit OWNER/ADMIN action: post (or re-post) the Match's attendance poll to a connected chat of this Group. */
export async function postAttendancePoll(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = attendancePollSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { chatRef, intent } = parsed.data;
  const groupId = context.activeGroup.id;

  const match = await findGroupMatch(context, matchId);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  if (match.status === "CANCELED") return NextResponse.json({ error: "This match is canceled." }, { status: 400 });
  const chat = await prisma.telegramChat.findFirst({ where: { id: chatRef, groupId, disconnectedAt: null }, select: { chatId: true } });
  if (!chat) return NextResponse.json({ error: "Telegram group not connected" }, { status: 404 });
  if (!process.env.TELEGRAM_BOT_TOKEN) return NextResponse.json({ error: "Missing TELEGRAM_BOT_TOKEN" }, { status: 500 });

  const content = attendancePollContent({ date: formatYMDFromDate(match.date), startTime: match.startTime, locationName: match.locationName });
  const destination = chat.chatId.toString();
  const contentHash = contentHashOf(JSON.stringify({ destination, question: content.question, options: content.options }));

  type Decision = { kind: "send"; deliveryId: string } | { kind: "respond"; response: NextResponse };
  const decision = await prisma.$transaction(async (tx): Promise<Decision> => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"match-poll:" + matchId}))`;
    const latest = (await tx.messageDelivery.findFirst({
      where: { matchId, groupId, eventType: EVENT, channel: CHANNEL, destination },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, contentHash: true, claimedAt: true },
    })) as PollDelivery | null;
    const now = new Date();
    const reserveNew = async (): Promise<Decision> => {
      const row = await tx.messageDelivery.create({
        data: { groupId, matchId, eventType: EVENT, channel: CHANNEL, destination, contentHash, status: "SENDING", claimedAt: now, createdByUserId: context.user.id },
        select: { id: true },
      });
      return { kind: "send", deliveryId: row.id };
    };
    const reserveExisting = async (id: string): Promise<Decision> => {
      await tx.messageDelivery.update({
        where: { id },
        data: { status: "SENDING", attempts: { increment: 1 }, claimedAt: now, contentHash, failureCode: null, failureDetail: null, failedAt: null, createdByUserId: context.user.id },
      });
      return { kind: "send", deliveryId: id };
    };
    const respond = (status: number, body: object): Decision => ({ kind: "respond", response: NextResponse.json(body, { status }) });

    if (!latest) return reserveNew();
    const stale = latest.status === "SENDING" && now.getTime() - latest.claimedAt.getTime() > STALE_SENDING_MS;
    if (latest.status === "SENDING" && !stale) return respond(409, { error: "This poll is being posted right now.", state: "sending" });
    if (latest.status === "UNCERTAIN" || stale) {
      if (intent !== "retry_uncertain") {
        return respond(409, { error: "The last attempt may or may not have reached Telegram. Check the Telegram group before retrying.", state: "uncertain" });
      }
      return reserveExisting(latest.id);
    }
    if (latest.status === "FAILED") return reserveExisting(latest.id);
    // SENT
    if (latest.contentHash === contentHash && intent !== "post_updated") {
      return respond(200, { ok: true, state: "already_posted" });
    }
    if (latest.contentHash !== contentHash && intent !== "post_updated") {
      return respond(409, { error: "The match details changed since the poll was posted. Post an updated poll?", state: "updated_available" });
    }
    return reserveNew();
  });
  if (decision.kind === "respond") return decision.response;

  // --- external send (outside any transaction) ---
  let sent: { message_id?: number; poll?: { id?: string } };
  try {
    sent = await callTelegram("sendPoll", { chat_id: destination, ...renderTelegramPoll(content) });
  } catch (e) {
    const definite = e instanceof TelegramApiRejectionError;
    await prisma.messageDelivery.update({
      where: { id: decision.deliveryId },
      data: definite
        ? { status: "FAILED", failedAt: new Date(), failureCode: "TELEGRAM_REJECTED", failureDetail: e.description?.slice(0, 300) ?? null }
        : { status: "UNCERTAIN", failedAt: new Date(), failureCode: "AMBIGUOUS" },
    });
    return NextResponse.json(
      definite
        ? { error: "Telegram rejected the poll. You can try again.", state: "failed" }
        : { error: "Telegram did not confirm the poll. Check the group before retrying.", state: "uncertain" },
      { status: 502 }
    );
  }

  const pollId = sent?.poll?.id ? String(sent.poll.id) : null;
  const messageId = sent?.message_id;
  if (!pollId || !messageId) {
    await prisma.messageDelivery.update({ where: { id: decision.deliveryId }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: "UNREADABLE" } });
    return NextResponse.json({ error: "Telegram did not confirm the poll. Check the group before retrying.", state: "uncertain" }, { status: 502 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.telegramPoll.create({
      data: {
        pollId,
        chatId: chat.chatId,
        messageId: BigInt(messageId),
        question: content.question,
        optionsJson: JSON.stringify(content.options),
        pollDate: match.date,
        isClosed: false,
        groupId,
        matchId,
        kind: "ATTENDANCE",
      },
    });
    await tx.messageDelivery.update({
      where: { id: decision.deliveryId },
      data: { status: "SENT", sentAt: new Date(), providerMessageId: String(messageId), telegramPollId: pollId },
    });
  });
  return NextResponse.json({ ok: true, state: "posted" }, { status: 201 });
}
