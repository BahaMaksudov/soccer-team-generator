import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { organizationPlan } from "@/lib/entitlements";
import { readGameDayUpdateSettings } from "@/lib/gameDayUpdateSettings";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { currentMatchLinkPath } from "@/lib/matchLink";
import { getAppBaseUrl } from "@/lib/email/config";
import { GAME_DAY_STATUS_TEXT, gameDayUpdateDecision, manualGameDayDecision, type GameDayBlock, type GameDayDecision, type GameDayFacts } from "@/lib/gameDayUpdateSchedule";
import { kickoffAt } from "@/lib/attendanceDeadline";
import { FORECAST_DAYS, weatherProvider } from "@/lib/weather";
import { buildGameDayUpdate as buildMessageHtml, timeLeftText, type GameDayUpdateMessage, type GameDayWeather } from "@/lib/messaging/gameDayUpdate";
import { PREVIEW_TTL_MS, signGameDayConfirm, verifyGameDayConfirm } from "@/lib/gameDayConfirmToken";

/**
 * Phase 4B (step 6) — Telegram Game Day Update delivery, driven by Match
 * Automation (cron + Run now; no second engine, no second bot). Destination =
 * the chat of the match's CURRENT open attendance poll (the most recently
 * posted one), strictly as a REPLY to that poll message (allow_sending_without_reply
 * false; a vanished poll message is a terminal failure) — never another chat,
 * never a broadcast, never a new poll. One successful update per match: reserved under
 * a database advisory lock ("gameday:<matchId>") with the existing
 * MessageDelivery state machine (SENDING → SENT / FAILED / UNCERTAIN); a
 * definite Telegram rejection is retried while eligible, an uncertain outcome
 * never automatically. Facts (settings, CURRENT plan, match, poll, chat,
 * deliveries) are re-read inside the lock right before reserving.
 *
 * Step 7 — kickoff weather: fetched only for an update that is due (lock-free
 * pre-check), OUTSIDE any transaction (no lock held during the provider call),
 * only when the Group includes weather and the match's venue has an
 * organizer-confirmed location and the match has a start time. Eligibility is
 * then re-checked inside the lock as before; any weather problem → sent without it.
 *
 * Manual "Send Game Day Update now" (previewManualGameDayUpdate → sendManualGameDayUpdate):
 * the organizer previews the exact message + destination, confirms, and the send
 * goes through the SAME lock, MessageDelivery row, strict reply and outcome
 * recording as the automatic one (one event per match → at most one SENT, manual
 * or automatic). It never reads or writes the automatic setting. An UNCERTAIN
 * outcome is never re-sent; the organizer may only mark it sent after checking
 * the chat (markGameDayUpdateSent — MARKED_SENT audit fields).
 *
 * Destination consistency (both paths): the poll's chat must be the match's
 * selected Telegram group — never another chat, never a silent switch.
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
      // The match's SELECTED Telegram group (destination consistency).
      telegramChat: { select: { chatId: true, groupId: true } },
      venue: { select: { name: true, isIndoor: true, weatherLatitude: true, weatherLongitude: true, weatherLocationConfirmedAt: true } },
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
      select: { pollId: true, chatId: true, messageId: true, createdAt: true, question: true },
    }),
    db.messageDelivery.findFirst({
      where: { matchId, groupId, eventType: EVENT, channel: CHANNEL },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, claimedAt: true, sentAt: true, failedAt: true, failureCode: true, createdByUserId: true, resolution: true, resolvedByUserId: true },
    }),
  ]);
  const pollChat = poll ? await db.telegramChat.findFirst({ where: { chatId: poll.chatId, groupId, disconnectedAt: null }, select: { title: true } }) : null;
  const chatConnected = pollChat !== null;
  const chatMatchesMatch = Boolean(poll && m.telegramChat && m.telegramChat.groupId === groupId && m.telegramChat.chatId === poll.chatId);
  const facts: GameDayFacts = {
    enabled: settings.enabled,
    hoursBefore: settings.hoursBefore,
    telegramAllowed: limits.telegram,
    matchStatus: m.status,
    attendanceClosedAt: m.attendanceClosedAt,
    attendanceDeadlineAt: m.attendanceDeadlineAt,
    schedule: m.scheduleId === null ? "none" : m.schedule?.isActive && !planPaused ? "active" : "paused",
    poll: poll ? { postedAt: poll.createdAt, chatConnected, chatMatchesMatch } : null,
    delivery,
  };
  return { m, settings, poll, delivery, facts, chatTitle: pollChat?.title ?? null };
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
  // Lock-free pre-check: nothing (no weather request, no counts) unless an update is due right now.
  const pre = await loadFacts(groupId, organizationId, matchId, now, prisma, params.planPaused);
  if (!pre || gameDayUpdateDecision(pre.facts, now).kind !== "send") return "not_due";
  const weather = pre.settings.includeWeather ? await kickoffWeather(pre.m, now) : null;
  const counts = await params.counts();
  const teamName = await readTeamName(groupId);

  const reserved = await prisma.$transaction(async (tx) => {
    await lockMatch(tx, matchId);
    const loaded = await loadFacts(groupId, organizationId, matchId, now, tx, params.planPaused);
    if (!loaded || !loaded.poll) return null;
    const decision = gameDayUpdateDecision(loaded.facts, now);
    if (decision.kind !== "send") return null;
    const message = buildMessage(loaded, teamName, counts, weather, now);
    if (!message.ok) return null;
    return reserve(tx, loaded, { groupId, matchId, userId: params.userId, html: message.html, now });
  });
  if (!reserved) return "not_due";
  return sendReserved(reserved);
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadFacts>>>;
type Reserved = { deliveryId: string; destination: string; replyTo: number; html: string };

/** The one Game Day lock (database advisory lock, transaction-scoped): automatic, manual and "mark as sent" all take it. */
async function lockMatch(tx: Prisma.TransactionClient, matchId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"gameday:" + matchId}))`;
}

async function readTeamName(groupId: string): Promise<string | null> {
  return (await prisma.groupSetting.findUnique({ where: { groupId_key: { groupId, key: "teamName" } }, select: { value: true } }))?.value ?? null;
}

/** The message from the loaded facts (shared by automatic, preview and manual send). */
function buildMessage(loaded: Loaded, teamName: string | null, counts: { PLAYING: number; MAYBE: number }, weather: GameDayWeather | null, now: Date): GameDayUpdateMessage {
  const { m } = loaded;
  if (!m.attendanceDeadlineAt) return { ok: false, reason: "INVALID_INPUT" };
  return buildMessageHtml({
    groupName: m.group.name,
    displayName: teamName,
    timezone: m.group.timezone,
    match: { date: m.date.toISOString().slice(0, 10), startTime: m.startTime, venueName: m.venue?.name ?? m.locationName, isIndoor: m.venue?.isIndoor ?? false },
    deadline: m.attendanceDeadlineAt,
    attendance: { playing: counts.PLAYING, maybe: counts.MAYBE },
    link: authorizedMatchLink(m.group.visibility, m.id, m.shareVersion),
    weather: loaded.settings.includeWeather ? weather : null, // re-checked: turned off meanwhile → none
    units: loaded.settings.units,
    now,
  });
}

/** Reserve the match's ONE Game Day delivery (inside the lock): a FAILED row is reused, otherwise a new SENDING row. */
async function reserve(tx: Prisma.TransactionClient, loaded: Loaded, p: { groupId: string; matchId: string; userId: string | null; html: string; now: Date; manual?: boolean }): Promise<Reserved> {
  const poll = loaded.poll!;
  const destination = poll.chatId.toString();
  const data = { destination, telegramPollId: poll.pollId, contentHash: contentHashOf(p.html), status: "SENDING" as const, claimedAt: p.now };
  const row =
    loaded.delivery?.status === "FAILED"
      ? await tx.messageDelivery.update({ where: { id: loaded.delivery.id }, data: { ...data, attempts: { increment: 1 }, failedAt: null, failureCode: null, failureDetail: null, ...(p.manual && p.userId ? { createdByUserId: p.userId } : {}) }, select: { id: true } })
      : await tx.messageDelivery.create({ data: { ...data, groupId: p.groupId, matchId: p.matchId, eventType: EVENT, channel: CHANNEL, createdByUserId: p.userId }, select: { id: true } });
  return { deliveryId: row.id, destination, replyTo: Number(poll.messageId), html: p.html };
}

/** The external send (outside any transaction) + the recorded outcome. Never throws for Telegram problems. */
async function sendReserved(reserved: Reserved): Promise<"sent" | "failed" | "uncertain"> {
  let sent: { message_id?: number };
  try {
    sent = await callTelegram("sendMessage", {
      chat_id: reserved.destination,
      text: reserved.html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      // Strict: ONLY as a reply to the attendance poll (Telegram refuses if that message is gone).
      reply_parameters: { message_id: reserved.replyTo, allow_sending_without_reply: false },
    });
  } catch (e) {
    const definite = e instanceof TelegramApiRejectionError;
    // The poll message to reply to is gone: terminal (never retried; never sent without the reply).
    const replyGone = definite && /repl(y|ied)[^.]*not found/i.test(e.description ?? "");
    await prisma.messageDelivery.update({
      where: { id: reserved.deliveryId },
      data: definite
        ? { status: "FAILED", failedAt: new Date(), failureCode: replyGone ? "REPLY_TARGET_MISSING" : "TELEGRAM_REJECTED", failureDetail: e.description?.slice(0, 300) ?? null }
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

export type WeatherReason = "INCLUDED" | "NO_VENUE" | "NO_LOCATION" | "NO_START_TIME" | "NOT_CONFIGURED" | "OUT_OF_RANGE" | "UNAVAILABLE";
type WeatherMatch = { date: Date; startTime: string | null; group: { timezone: string }; venue: { weatherLatitude: number | null; weatherLongitude: number | null; weatherLocationConfirmedAt: Date | null } | null };

/** The kickoff forecast for a match whose venue has a CONFIRMED location, with why there is none (never throws). */
async function kickoffWeatherCheck(m: WeatherMatch, now: Date): Promise<{ weather: GameDayWeather | null; reason: WeatherReason }> {
  const v = m.venue;
  if (!v) return { weather: null, reason: "NO_VENUE" };
  if (v.weatherLatitude === null || v.weatherLongitude === null || !v.weatherLocationConfirmedAt) return { weather: null, reason: "NO_LOCATION" };
  if (!m.startTime) return { weather: null, reason: "NO_START_TIME" }; // kickoff time unknown: no forecast (never "some hour" of the day)
  const provider = weatherProvider();
  if (!provider) return { weather: null, reason: "NOT_CONFIGURED" };
  const kickoff = kickoffAt(m.date, m.startTime, m.group.timezone);
  let weather: GameDayWeather | null = null;
  try {
    weather = await provider.forecastAt(v.weatherLatitude, v.weatherLongitude, kickoff, now);
  } catch {
    weather = null;
  }
  if (weather) return { weather, reason: "INCLUDED" };
  const ahead = kickoff.getTime() - now.getTime();
  return { weather: null, reason: ahead < 0 || ahead > (FORECAST_DAYS - 1) * 86_400_000 ? "OUT_OF_RANGE" : "UNAVAILABLE" };
}

async function kickoffWeather(m: WeatherMatch, now: Date): Promise<GameDayWeather | null> {
  return (await kickoffWeatherCheck(m, now)).weather;
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

// ================================================================ manual "Send Game Day Update now"

export type ManualState = "READY" | "ALREADY_SENT" | "UNCERTAIN" | "SENDING" | "UNAVAILABLE";

/** Organizer-facing reasons for the manual action (no ids, tokens or provider details). */
export const MANUAL_REASON_TEXT: Record<GameDayBlock, string> = {
  SENT: "A Game Day Update was already sent for this match.",
  UNCERTAIN: "The last send may or may not have reached Telegram. Check the Telegram group before doing anything else.",
  SENDING: "A Game Day Update is being sent right now.",
  DISABLED: "Automatic Game Day Updates are off.", // never applies to the manual action
  NOT_IN_PLAN: "Telegram messages aren't available on your plan (Telegram is part of Pro).",
  INACTIVE: "The match isn't scheduled (completed or canceled).",
  CLOSED: "Attendance is closed for this match.",
  NO_DEADLINE: "This match has no attendance deadline. Set one in Edit match (Attendance deadline) — the update tells players when attendance closes, so it can't be sent without one.",
  SCHEDULE_PAUSED: "The recurring schedule is paused.", // never applies to the manual action
  NO_POLL: "There's no open Telegram attendance poll for this match. Post the attendance poll first — the update is sent as a reply to it.",
  CHAT_DISCONNECTED: "The attendance poll's Telegram group is disconnected.",
  CHAT_MISMATCH: "The open attendance poll is in a different Telegram group than this match's selected group. Nothing is sent to a different group — select the right group or post the poll there.",
  POLL_MESSAGE_MISSING: "The attendance poll message is no longer in the Telegram group, so the update can't be sent as a reply to it.",
  TOO_CLOSE: "Less than 30 minutes remain before attendance closes.",
};

const stateOfBlock = (reason: GameDayBlock): ManualState =>
  reason === "SENT" ? "ALREADY_SENT" : reason === "UNCERTAIN" ? "UNCERTAIN" : reason === "SENDING" ? "SENDING" : "UNAVAILABLE";

export type GameDayPreview = {
  state: ManualState;
  reason: GameDayBlock | null;
  text: string;
  organization: string;
  group: string;
  /** The ONE destination: the poll's Telegram group (= the match's selected group) and the poll replied to. */
  destination: { chatTitle: string; pollQuestion: string; pollPostedAt: string } | null;
  deadline: { at: string; timeLeft: string } | null;
  /** The exact Telegram text (HTML parse mode) that would be sent. */
  message: { html: string; truncated: boolean } | null;
  /** Read-only kickoff weather check (also when it isn't part of the message). */
  weather: {
    reason: WeatherReason;
    includedInMessage: boolean;
    forecast: { temperatureC: number | null; condition: string | null; rainChancePercent: number | null; windKph: number | null } | null;
  };
  automaticEnabled: boolean;
  units: "imperial" | "metric";
  /** Present only when READY. */
  token: string | null;
  expiresAt: string | null;
  /** Relative validity (the browser counts down from when it received the preview — no clock skew). */
  expiresInSeconds: number | null;
  sent: { at: string | null; by: string | null; markedSent: boolean } | null;
  /** The delivery an organizer may mark as sent (UNCERTAIN only). */
  uncertainDeliveryId: string | null;
};

type ManualParams = {
  groupId: string;
  organizationId: string;
  organizationName: string;
  matchId: string;
  userId: string;
  counts: () => Promise<{ PLAYING: number; MAYBE: number }>;
};

async function userName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true, email: true } });
  return u ? u.name?.trim() || u.email : null;
}

/**
 * Read-only preview of the manual Game Day Update: state, destination, exact
 * message, weather check — and, only when READY, the signed confirmation.
 * Sends nothing, writes nothing (one weather request at most).
 */
export async function previewManualGameDayUpdate(p: ManualParams, now: Date = new Date()): Promise<GameDayPreview | null> {
  const loaded = await loadFacts(p.groupId, p.organizationId, p.matchId, now, prisma, false);
  if (!loaded) return null;
  const { m, poll, delivery, settings } = loaded;
  const decision = manualGameDayDecision(loaded.facts, now);
  const weatherCheck = await kickoffWeatherCheck(m, now);
  const counts = await p.counts();
  const teamName = await readTeamName(p.groupId);
  const deadline = m.attendanceDeadlineAt;
  const message = deadline && deadline.getTime() > now.getTime() ? buildMessage(loaded, teamName, counts, weatherCheck.weather, now) : null;
  const included = Boolean(settings.includeWeather && weatherCheck.weather);

  let token: string | null = null;
  if (decision.kind === "ready" && message?.ok && poll && deadline) {
    token = signGameDayConfirm({
      o: p.organizationId,
      g: p.groupId,
      m: p.matchId,
      u: p.userId,
      p: poll.pollId,
      c: poll.chatId.toString(),
      d: deadline.getTime(),
      pl: counts.PLAYING,
      mb: counts.MAYBE,
      w: included ? weatherCheck.weather : null,
      h: contentHashOf(message.html),
      iat: now.getTime(),
    });
  }
  const state: ManualState = decision.kind === "ready" ? (token ? "READY" : "UNAVAILABLE") : stateOfBlock(decision.reason);
  const reason = decision.kind === "ready" ? null : decision.reason;
  const w = weatherCheck.weather;
  return {
    state,
    reason,
    text:
      state === "READY"
        ? "Ready to send."
        : reason
          ? MANUAL_REASON_TEXT[reason]
          : "Manual sending isn't configured on this server.",
    organization: p.organizationName,
    group: m.group.name,
    destination: poll && loaded.facts.poll?.chatConnected ? { chatTitle: loaded.chatTitle ?? "Untitled Telegram group", pollQuestion: poll.question, pollPostedAt: poll.createdAt.toISOString() } : null,
    deadline: deadline ? { at: deadline.toISOString(), timeLeft: deadline.getTime() > now.getTime() ? timeLeftText(deadline.getTime() - now.getTime()) : "closed" } : null,
    message: message?.ok ? { html: message.html, truncated: message.truncated } : null,
    weather: {
      reason: weatherCheck.reason,
      includedInMessage: included,
      forecast: w ? { temperatureC: w.temperatureC ?? null, condition: w.condition ?? null, rainChancePercent: w.rainChancePercent ?? null, windKph: w.windKph ?? null } : null,
    },
    automaticEnabled: settings.enabled,
    units: settings.units,
    token,
    expiresAt: token ? new Date(now.getTime() + PREVIEW_TTL_MS).toISOString() : null,
    expiresInSeconds: token ? Math.floor(PREVIEW_TTL_MS / 1000) : null,
    sent:
      delivery?.status === "SENT"
        ? { at: delivery.sentAt?.toISOString() ?? null, by: await userName(delivery.resolution === "MARKED_SENT" ? delivery.resolvedByUserId : delivery.createdByUserId), markedSent: delivery.resolution === "MARKED_SENT" }
        : null,
    uncertainDeliveryId: delivery && (delivery.status === "UNCERTAIN" || (delivery.status === "SENDING" && now.getTime() - delivery.claimedAt.getTime() > STALE_SENDING_MS)) ? delivery.id : null,
  };
}

export type ManualSendResult =
  | { kind: "sent" | "failed" | "uncertain" }
  | { kind: "invalid" }
  | { kind: "stale"; why: "EXPIRED" | "CHANGED" }
  | { kind: "blocked"; reason: GameDayBlock };

/**
 * Send the previewed message — only if the confirmation is valid, the match is
 * still eligible right now (manual rules, inside the lock), the destination,
 * deadline and counts are unchanged, and the message rebuilt from the current
 * facts at the preview instant is byte-identical to the approved one.
 */
export async function sendManualGameDayUpdate(p: ManualParams & { token: unknown }, now: Date = new Date()): Promise<ManualSendResult> {
  const v = verifyGameDayConfirm(p.token, { o: p.organizationId, g: p.groupId, m: p.matchId, u: p.userId }, now.getTime());
  if (!v.ok) return v.reason === "EXPIRED" ? { kind: "stale", why: "EXPIRED" } : { kind: "invalid" };
  const c = v.claims;
  const counts = await p.counts();
  const teamName = await readTeamName(p.groupId);

  const outcome = await prisma.$transaction(async (tx): Promise<{ reserved: Reserved } | ManualSendResult> => {
    await lockMatch(tx, p.matchId);
    const loaded = await loadFacts(p.groupId, p.organizationId, p.matchId, now, tx, false);
    if (!loaded) return { kind: "invalid" };
    const decision = manualGameDayDecision(loaded.facts, now);
    if (decision.kind !== "ready") return { kind: "blocked", reason: decision.reason };
    const { poll, m } = loaded;
    const same =
      poll !== null &&
      poll.pollId === c.p &&
      poll.chatId.toString() === c.c &&
      m.attendanceDeadlineAt?.getTime() === c.d &&
      counts.PLAYING === c.pl &&
      counts.MAYBE === c.mb;
    if (!same) return { kind: "stale", why: "CHANGED" };
    // Rebuilt at the PREVIEW instant with the previewed weather: identical text or nothing is sent.
    const message = buildMessage(loaded, teamName, counts, c.w, new Date(c.iat));
    if (!message.ok || contentHashOf(message.html) !== c.h) return { kind: "stale", why: "CHANGED" };
    return { reserved: await reserve(tx, loaded, { groupId: p.groupId, matchId: p.matchId, userId: p.userId, html: message.html, now, manual: true }) };
  });
  if (!("reserved" in outcome)) return outcome;
  return { kind: await sendReserved(outcome.reserved) };
}

/**
 * Organizer recovery after checking the Telegram group: the match's latest Game
 * Day delivery is UNCERTAIN (or an abandoned SENDING) and IS in the chat → SENT
 * with the MARKED_SENT audit fields. Never sends anything.
 */
export async function markGameDayUpdateSent(p: { groupId: string; matchId: string; deliveryId: string; userId: string }, now: Date = new Date()): Promise<"ok" | "not_latest" | "not_uncertain"> {
  return prisma.$transaction(async (tx) => {
    await lockMatch(tx, p.matchId);
    const latest = await tx.messageDelivery.findFirst({
      where: { matchId: p.matchId, groupId: p.groupId, eventType: EVENT, channel: CHANNEL },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, claimedAt: true },
    });
    if (!latest || latest.id !== p.deliveryId) return "not_latest";
    const stale = latest.status === "SENDING" && now.getTime() - latest.claimedAt.getTime() > STALE_SENDING_MS;
    if (!(latest.status === "UNCERTAIN" || stale)) return "not_uncertain";
    await tx.messageDelivery.update({ where: { id: latest.id }, data: { status: "SENT", sentAt: now, resolution: "MARKED_SENT", resolvedAt: now, resolvedByUserId: p.userId } });
    return "ok";
  });
}
