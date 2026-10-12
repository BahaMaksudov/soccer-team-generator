import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { organizationPlan } from "@/lib/entitlements";
import { readGameDayUpdateSettings } from "@/lib/gameDayUpdateSettings";
import { buildGameDayUpdate } from "@/lib/messaging/gameDayUpdate";
import { contentHashOf } from "@/lib/messaging/deliveryState";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { currentMatchLinkPath } from "@/lib/matchLink";
import { getAppBaseUrl } from "@/lib/email/config";
import { GAME_DAY_STATUS_TEXT, gameDayUpdateDecision, type GameDayDecision, type GameDayFacts } from "@/lib/gameDayUpdateSchedule";

/**
 * Phase 4B (step 6) — Telegram Game Day Update delivery, driven by Match
 * Automation (cron + Run now; no second engine, no second bot). Destination =
 * the chat of the match's CURRENT open attendance poll (the most recently
 * posted one), as a REPLY to that poll message — never another chat, never a
 * broadcast, never a new poll. One successful update per match: reserved under
 * a database advisory lock ("gameday:<matchId>") with the existing
 * MessageDelivery state machine (SENDING → SENT / FAILED / UNCERTAIN); a
 * definite Telegram rejection is retried while eligible, an uncertain outcome
 * never automatically. Facts (settings, CURRENT plan, match, poll, chat,
 * deliveries) are re-read inside the lock right before reserving. Weather is
 * not part of this step (null).
 */
const EVENT = "GAME_DAY_UPDATE_POSTED" as const;
const CHANNEL = "TELEGRAM" as const;

type Db = Prisma.TransactionClient | typeof prisma;

async function loadFacts(groupId: string, organizationId: string, matchId: string, now: Date, db: Db, planPaused: boolean) {
  const m = await db.match.findFirst({
    where: { id: matchId, groupId },
    select: {
      id: true,
      status: true,
      date: true,
      startTime: true,
      locationName: true,
      shareVersion: true,
      attendanceClosedAt: true,
      attendanceDeadlineAt: true,
      scheduleId: true,
      schedule: { select: { isActive: true } },
      venue: { select: { name: true, isIndoor: true } },
      group: { select: { name: true, timezone: true, visibility: true } },
    },
  });
  if (!m) return null;
  const [settings, { limits }, poll, delivery] = await Promise.all([
    readGameDayUpdateSettings(groupId),
    organizationPlan(organizationId, now, db),
    // Deterministic destination: the most recently posted OPEN attendance poll of THIS match.
    db.telegramPoll.findFirst({
      where: { matchId, groupId, kind: "ATTENDANCE", isClosed: false, messageId: { not: null } },
      orderBy: [{ createdAt: "desc" }, { pollId: "desc" }],
      select: { pollId: true, chatId: true, messageId: true, createdAt: true },
    }),
    db.messageDelivery.findFirst({
      where: { matchId, groupId, eventType: EVENT, channel: CHANNEL },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, claimedAt: true, sentAt: true, failedAt: true },
    }),
  ]);
  const chatConnected = poll ? (await db.telegramChat.count({ where: { chatId: poll.chatId, groupId, disconnectedAt: null } })) > 0 : false;
  const facts: GameDayFacts = {
    enabled: settings.enabled,
    hoursBefore: settings.hoursBefore,
    telegramAllowed: limits.telegram,
    matchStatus: m.status,
    attendanceClosedAt: m.attendanceClosedAt,
    attendanceDeadlineAt: m.attendanceDeadlineAt,
    schedule: m.scheduleId === null ? "none" : m.schedule?.isActive && !planPaused ? "active" : "paused",
    poll: poll ? { postedAt: poll.createdAt, chatConnected } : null,
    delivery,
  };
  return { m, settings, poll, delivery, facts };
}

/** The Match Link, only where the existing rules allow it (not PRIVATE, share secret + https base URL configured). */
function authorizedMatchLink(visibility: string, matchId: string, shareVersion: number): string | null {
  if (visibility === "PRIVATE") return null;
  const path = currentMatchLinkPath(matchId, shareVersion);
  if (!path) return null;
  try {
    return `${getAppBaseUrl()}${path}`;
  } catch {
    return null;
  }
}

export type GameDayResult = "sent" | "failed" | "uncertain" | "not_due";

/**
 * Send this match's Game Day Update if — by the CURRENT facts, inside the lock —
 * it is due. `counts` = the existing attendance summary (effective statuses,
 * organizer overrides included). Never throws for Telegram problems.
 */
export async function deliverGameDayUpdate(params: {
  groupId: string;
  organizationId: string;
  matchId: string;
  userId: string | null;
  now: Date;
  planPaused: boolean;
  counts: () => Promise<{ PLAYING: number; MAYBE: number }>;
}): Promise<GameDayResult> {
  const { groupId, organizationId, matchId, now } = params;
  const counts = await params.counts();
  const teamName = (await prisma.groupSetting.findUnique({ where: { groupId_key: { groupId, key: "teamName" } }, select: { value: true } }))?.value ?? null;

  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"gameday:" + matchId}))`;
    const loaded = await loadFacts(groupId, organizationId, matchId, now, tx, params.planPaused);
    if (!loaded || !loaded.poll) return null;
    const decision = gameDayUpdateDecision(loaded.facts, now);
    if (decision.kind !== "send") return null;
    const { m, poll } = loaded;
    const message = buildGameDayUpdate({
      groupName: m.group.name,
      displayName: teamName,
      timezone: m.group.timezone,
      match: { date: m.date.toISOString().slice(0, 10), startTime: m.startTime, venueName: m.venue?.name ?? m.locationName, isIndoor: m.venue?.isIndoor ?? false },
      deadline: m.attendanceDeadlineAt!,
      attendance: { playing: counts.PLAYING, maybe: counts.MAYBE },
      link: authorizedMatchLink(m.group.visibility, m.id, m.shareVersion),
      weather: null, // Step 7
      units: loaded.settings.units,
      now,
    });
    if (!message.ok) return null;
    const destination = poll.chatId.toString();
    const data = { destination, telegramPollId: poll.pollId, contentHash: contentHashOf(message.html), status: "SENDING" as const, claimedAt: now };
    const row =
      loaded.delivery?.status === "FAILED"
        ? await tx.messageDelivery.update({ where: { id: loaded.delivery.id }, data: { ...data, attempts: { increment: 1 }, failedAt: null, failureCode: null, failureDetail: null }, select: { id: true } })
        : await tx.messageDelivery.create({ data: { ...data, groupId, matchId, eventType: EVENT, channel: CHANNEL, createdByUserId: params.userId }, select: { id: true } });
    return { deliveryId: row.id, destination, replyTo: Number(poll.messageId), html: message.html };
  });
  if (!reserved) return "not_due";

  // --- external send (outside any transaction) ---
  let sent: { message_id?: number };
  try {
    sent = await callTelegram("sendMessage", {
      chat_id: reserved.destination,
      text: reserved.html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_parameters: { message_id: reserved.replyTo, allow_sending_without_reply: true },
    });
  } catch (e) {
    const definite = e instanceof TelegramApiRejectionError;
    await prisma.messageDelivery.update({
      where: { id: reserved.deliveryId },
      data: definite
        ? { status: "FAILED", failedAt: new Date(), failureCode: "TELEGRAM_REJECTED", failureDetail: e.description?.slice(0, 300) ?? null }
        : { status: "UNCERTAIN", failedAt: new Date(), failureCode: "AMBIGUOUS" },
    });
    return definite ? "failed" : "uncertain";
  }
  if (!sent?.message_id) {
    await prisma.messageDelivery.update({ where: { id: reserved.deliveryId }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: "UNREADABLE" } });
    return "uncertain";
  }
  await prisma.messageDelivery.update({ where: { id: reserved.deliveryId }, data: { status: "SENT", sentAt: new Date(), providerMessageId: String(sent.message_id) } });
  return "sent";
}

export type GameDayStatusView = { state: string; text: string; at: string | null };

/** Organizer-facing status of a match's Game Day Update (read-only; same decision as the sender). */
export async function gameDayUpdateStatus(groupId: string, organizationId: string, matchId: string, planPaused: boolean, now: Date = new Date()): Promise<GameDayStatusView | null> {
  const loaded = await loadFacts(groupId, organizationId, matchId, now, prisma, planPaused);
  if (!loaded) return null;
  return statusOf(gameDayUpdateDecision(loaded.facts, now));
}

export function statusOf(d: GameDayDecision): GameDayStatusView {
  if (d.kind === "wait") return { state: "WAIT", text: GAME_DAY_STATUS_TEXT.WAIT, at: d.dueAt.toISOString() };
  if (d.kind === "send") return d.retry ? { state: "RETRY", text: GAME_DAY_STATUS_TEXT.RETRY, at: null } : { state: "DUE", text: GAME_DAY_STATUS_TEXT.DUE, at: d.dueAt.toISOString() };
  return { state: d.reason, text: GAME_DAY_STATUS_TEXT[d.reason], at: d.reason === "SENT" && d.at ? d.at.toISOString() : null };
}
