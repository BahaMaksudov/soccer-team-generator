import { managersOnlyResponse } from "@/lib/tenantRoute";
import { telegramDenied } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatTeamsHtml, resolvePollDisplayDate } from "@/lib/telegramFormat";
import { callTelegram, TelegramAmbiguousError, TelegramApiRejectionError } from "@/lib/telegramApi";
import {
  persistedTeamsSchema,
  telegramCloseAndPostSchema,
  telegramDeliveryActionSchema,
  zodErrorResponse,
} from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";
import { renderTelegramHtml } from "@/lib/messaging/telegram";
import { teamsContent } from "@/lib/messaging/content";
import { playerFacingViewUrl } from "@/lib/messaging/links";
import {
  contentHashOf,
  deliveryStateOf,
  isStaleSending,
  type CurrentContent,
  type DeliveryRecord,
  type DeliveryState,
} from "@/lib/messaging/deliveryState";
import { hashToken, isWellFormedToken } from "@/lib/secureToken";
import { mapsUrl } from "@/lib/venues";

/**
 * Canonical Close Poll + Post Teams (Phase 2D.6D.5D), on durable
 * per-channel delivery records since M6-B.
 *
 * Two separate concerns, run in this order by the one convenient action:
 *   1. closeTelegramPoll()  — Telegram-poll semantics only (stopPoll);
 *   2. TEAMS_PUBLISHED → TELEGRAM delivery — a MessageDelivery row,
 *      independent of polls (future channels reuse the same states).
 *
 * Validation (before any Telegram call or delivery write): the poll, the
 * TeamGeneration AND the destination TelegramChat are all loaded scoped to
 * context.activeGroup.id; the poll must have a pollDate on the same UTC
 * day as the generation; the message is formatted ONLY from the persisted
 * TeamGeneration.teamsJson.
 *
 * Delivery (src/lib/messaging/deliveryState.ts):
 *   - the decision + reservation (SENDING) run in one transaction holding a
 *     per-poll advisory lock — concurrent clicks cannot both send;
 *   - Telegram accepts → SENT (+ provider message id);
 *   - Telegram definitively rejects → FAILED (retry allowed);
 *   - timeout / network / unreadable reply → UNCERTAIN: never retried
 *     automatically; an organizer either marks it sent or explicitly
 *     retries (which can duplicate the message — Telegram has no
 *     idempotency key);
 *   - same content already SENT → already_posted (nothing sent);
 *   - different content than the last SENT → "updated_available": only an
 *     explicit intent=post_updated sends another message.
 *
 * Compatibility: the pre-M6-B TelegramPoll posting columns are still read
 * (a poll with a legacy state but no delivery row gets one first) and
 * still written on success, so already-posted polls are never treated as
 * unposted and a rollback to the previous release stays safe.
 *
 * Canonical Telegram side effects are ONLY stopPoll and the teams
 * message. Nothing here stores raw provider responses, URLs or tokens.
 */

export type CloseStatus =
  | "closed_now"
  | "already_closed_locally"
  | "already_closed_on_telegram"
  | "missing_message_id"
  | "close_failed";

export type CloseAndPostStatus =
  | "posted"
  | "already_posted"
  | "updated_available"
  | "post_in_progress_or_unknown"
  | "delivery_uncertain"
  | "telegram_rejected"
  | "delivery_unknown"
  | "delivered_confirmation_failed";

const VERIFY_CHAT_MESSAGE =
  "A previous attempt to post teams for this poll may have reached Telegram. " +
  "Check the Telegram chat before doing anything else — do not retry automatically.";

const CHANNEL = "TELEGRAM" as const;
const EVENT = "TEAMS_PUBLISHED" as const;
const MAX_FAILURE_DETAIL = 200;

const DELIVERY_SELECT = {
  id: true,
  status: true,
  contentHash: true,
  teamGenerationId: true,
  claimedAt: true,
  sentAt: true,
  createdAt: true,
  attempts: true,
  failureCode: true,
} as const;

type PollRow = {
  pollId: string;
  chatId: bigint;
  messageId: bigint | null;
  question: string;
  pollDate: Date | null;
  isClosed: boolean;
  matchId?: string | null;
};

const lockPoll = (tx: Prisma.TransactionClient, pollId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"delivery:TELEGRAM:" + pollId}))`;

/**
 * Loads this poll's TEAMS_PUBLISHED/TELEGRAM deliveries inside the lock.
 * Dual-read: a poll that still has only the pre-M6-B posting columns gets
 * the equivalent delivery row first (POSTED → SENT, SENDING → UNCERTAIN).
 */
async function loadDeliveriesInTx(tx: Prisma.TransactionClient, activeGroupId: string, pollId: string): Promise<DeliveryRecord[]> {
  const where = { groupId: activeGroupId, telegramPollId: pollId, channel: CHANNEL, eventType: EVENT };
  const rows = await tx.messageDelivery.findMany({ where, select: DELIVERY_SELECT });
  if (rows.length > 0) return rows;

  const legacy = await tx.telegramPoll.findFirst({
    where: { pollId, groupId: activeGroupId },
    select: { chatId: true, teamsPostStatus: true, postedTeamGenerationId: true, teamsPostClaimedAt: true, teamsPostedAt: true, updatedAt: true },
  });
  if (!legacy?.teamsPostStatus) return [];
  const generation = legacy.postedTeamGenerationId
    ? await tx.teamGeneration.findFirst({ where: { id: legacy.postedTeamGenerationId, groupId: activeGroupId }, select: { id: true } })
    : null;
  const created = await tx.messageDelivery.create({
    data: {
      groupId: activeGroupId,
      eventType: EVENT,
      channel: CHANNEL,
      destination: legacy.chatId.toString(),
      telegramPollId: pollId,
      teamGenerationId: generation?.id ?? null,
      contentHash: "legacy",
      status: legacy.teamsPostStatus === "POSTED" ? "SENT" : "UNCERTAIN",
      claimedAt: legacy.teamsPostClaimedAt ?? legacy.teamsPostedAt ?? legacy.updatedAt,
      sentAt: legacy.teamsPostedAt,
      failureCode: legacy.teamsPostStatus === "SENDING" ? "STALE_RESERVATION" : null,
    },
    select: DELIVERY_SELECT,
  });
  return [created];
}

/** Telegram-poll concern only: close the poll if it is still open. Never blocks posting. */
async function closeTelegramPoll(poll: PollRow, activeGroupId: string): Promise<CloseStatus> {
  if (poll.isClosed) return "already_closed_locally";
  if (poll.messageId == null) return "missing_message_id";
  let closeStatus: CloseStatus;
  try {
    await callTelegram("stopPoll", { chat_id: poll.chatId.toString(), message_id: Number(poll.messageId) });
    closeStatus = "closed_now";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    closeStatus =
      e instanceof TelegramApiRejectionError && msg.toLowerCase().includes("already been closed")
        ? "already_closed_on_telegram"
        : "close_failed";
  }
  if (closeStatus === "closed_now" || closeStatus === "already_closed_on_telegram") {
    await prisma.telegramPoll
      .updateMany({ where: { pollId: poll.pollId, groupId: activeGroupId }, data: { isClosed: true } })
      .catch(() => {
        // Telegram is the source of truth for the poll being closed;
        // a failed local sync is reconciled on the next attempt.
      });
  }
  return closeStatus;
}

type Validated = {
  poll: PollRow;
  generation: { id: string; date: Date; updatedAt: Date; matchId: string | null };
  body: string;
  current: CurrentContent;
  displayDate: string;
  teams: Array<{ teamNumber: number; players: Array<{ firstName?: string | null; lastName?: string | null }> }>;
};

/** Shared, side-effect-free validation for posting and status. */
async function validatePostTarget(
  context: TenantContext,
  pollId: string,
  teamGenerationId: string
): Promise<{ ok: true; value: Validated } | { ok: false; response: NextResponse }> {
  const activeGroupId = context.activeGroup.id;
  const fail = (error: string, status: number) => ({ ok: false as const, response: NextResponse.json({ error }, { status }) });

  // poll, generation and destination chat — all scoped to the active Group (foreign == missing)
  // M9-D — teams are posted against ATTENDANCE polls only (never an MVP poll).
  const poll = await prisma.telegramPoll.findFirst({
    where: { pollId, groupId: activeGroupId, kind: "ATTENDANCE" },
    select: { pollId: true, chatId: true, messageId: true, question: true, pollDate: true, isClosed: true, matchId: true },
  });
  if (!poll) return fail("Poll not found", 404);

  const generation = await prisma.teamGeneration.findFirst({
    where: { id: teamGenerationId, groupId: activeGroupId },
    select: { id: true, date: true, updatedAt: true, teamsJson: true, matchId: true },
  });
  if (!generation) return fail("Published teams not found", 404);

  // M9-B — only a CONNECTED chat of this Group (a disconnected binding is history).
  const chat = await prisma.telegramChat.findFirst({ where: { chatId: poll.chatId, groupId: activeGroupId, disconnectedAt: null }, select: { chatId: true } });
  if (!chat) return fail("Telegram chat not found", 404);
  // M9-B — a Match's poll posts only THAT Match's published teams (two Matches
  // can share a date, so the date check below is not enough on its own).
  if (poll.matchId && generation.matchId !== poll.matchId) {
    return fail("These published teams belong to a different match than this poll.", 400);
  }

  if (!poll.pollDate) return fail("This poll has no poll date, so it cannot be matched to published teams.", 400);
  if (toDateOnlyUTC(poll.pollDate).getTime() !== toDateOnlyUTC(generation.date).getTime()) {
    return fail("The poll date does not match the published teams date.", 400);
  }

  let teams;
  try {
    const result = persistedTeamsSchema.safeParse(JSON.parse(generation.teamsJson));
    if (!result.success) throw new Error("invalid");
    teams = result.data;
  } catch {
    return fail("The published teams could not be read. Re-publish before posting.", 422);
  }

  const displayDate = resolvePollDisplayDate(poll, null);
  const body = formatTeamsHtml(displayDate, teams);
  return {
    ok: true,
    value: {
      poll,
      generation: { id: generation.id, date: generation.date, updatedAt: generation.updatedAt, matchId: generation.matchId },
      body,
      displayDate,
      teams,
      current: { contentHash: contentHashOf(body), teamGenerationId: generation.id, generationUpdatedAt: generation.updatedAt },
    },
  };
}

/**
 * The player-facing link for this Group's message (never stored):
 * PUBLIC → canonical page; LINK → only an explicitly supplied, ACTIVE
 * share link of this same Group; PRIVATE → none.
 */
export async function resolveViewUrl(
  context: TenantContext,
  shareUrl: string | undefined,
  // M9-C — the Match of the POSTED generation (never inferred); null for legacy by-date teams.
  matchId: string | null
): Promise<{ ok: true; url: string | null } | { ok: false; response: NextResponse }> {
  const group = await prisma.group.findFirst({
    where: { id: context.activeGroup.id, organizationId: context.organization.id },
    select: { visibility: true },
  });
  const visibility = group?.visibility ?? "PRIVATE";
  const base = { organizationSlug: context.organization.slug, groupSlug: context.activeGroup.slug };

  if (visibility === "PUBLIC") return { ok: true, url: playerFacingViewUrl({ ...base, visibility, matchId }) };
  if (visibility !== "LINK" || !shareUrl) return { ok: true, url: null };

  const invalid = {
    ok: false as const,
    response: NextResponse.json({ error: "That share link is not an active link for this group." }, { status: 400 }),
  };
  const url = playerFacingViewUrl({ ...base, visibility, shareUrl, matchId });
  const token = url?.split("#")[1];
  if (!url || !isWellFormedToken(token)) return invalid;
  const link = await prisma.groupShareLink.findFirst({
    where: { tokenHash: hashToken(token), groupId: context.activeGroup.id, revokedAt: null },
    select: { id: true },
  });
  return link ? { ok: true, url } : invalid;
}

function stateResponse(state: DeliveryState, closeStatus: CloseStatus | null, teamGenerationId: string): NextResponse {
  switch (state.kind) {
    case "posted":
      return NextResponse.json({ ok: true, status: "already_posted" satisfies CloseAndPostStatus, closeStatus, teamGenerationId });
    case "sending":
      return NextResponse.json(
        { ok: false, status: "post_in_progress_or_unknown" satisfies CloseAndPostStatus, closeStatus, error: VERIFY_CHAT_MESSAGE },
        { status: 409 }
      );
    case "uncertain":
      return NextResponse.json(
        {
          ok: false,
          status: "delivery_uncertain" satisfies CloseAndPostStatus,
          closeStatus,
          deliveryId: state.delivery.id,
          error: "Delivery status uncertain. Check the Telegram chat, then mark it as sent or retry.",
        },
        { status: 409 }
      );
    case "updated_available":
      return NextResponse.json(
        {
          ok: false,
          status: "updated_available" satisfies CloseAndPostStatus,
          closeStatus,
          error: "Different teams were already posted for this poll. Use “Post Updated Teams” to send another message.",
        },
        { status: 409 }
      );
    default:
      return NextResponse.json({ error: "Unexpected delivery state." }, { status: 500 });
  }
}

export async function closePollAndPostTeamsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  // M9-A — Telegram (provider identity / external sends) is OWNER/ADMIN only.
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  // M11.1 — Telegram is a Pro capability (after the role check: MEMBER still gets the generic 404).
  const notInPlan = await telegramDenied(context.organization.id);
  if (notInPlan) return notInPlan;
  const activeGroupId = context.activeGroup.id;

  const raw = await req.json().catch(() => null);
  if (!raw) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = telegramCloseAndPostSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { pollId, teamGenerationId, intent, deliveryId, shareUrl } = parsed.data;

  const validated = await validatePostTarget(context, pollId, teamGenerationId);
  if (!validated.ok) return validated.response;
  const { poll, current, body, displayDate, teams, generation } = validated.value;

  // M9-C — Match teams link to that Match's page; the content hash stays the
  // body WITHOUT the link (contentHashOf(body)), so the URL form (Group page →
  // Match page, or a rotated share token) never makes the same teams look
  // "updated" and no token is ever hashed or stored.
  const view = await resolveViewUrl(context, shareUrl, generation.matchId);
  if (!view.ok) return view.response;

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: "Missing TELEGRAM_BOT_TOKEN" }, { status: 500 });
  }

  // --- decide + reserve, atomically per poll ---
  type Decision =
    | { kind: "send"; deliveryId: string }
    | { kind: "already_posted"; state: DeliveryState }
    | { kind: "reject"; state: DeliveryState };
  let decision: Decision;
  try {
    decision = await prisma.$transaction(async (tx): Promise<Decision> => {
      await lockPoll(tx, pollId);
      const now = new Date();
      const deliveries = await loadDeliveriesInTx(tx, activeGroupId, pollId);
      const state = deliveryStateOf(deliveries, current, now);

      const reserveExisting = async (id: string) => {
        const { count } = await tx.messageDelivery.updateMany({
          where: { id, groupId: activeGroupId, status: { in: ["FAILED", "UNCERTAIN", "SENDING"] } },
          data: {
            status: "SENDING",
            attempts: { increment: 1 },
            claimedAt: now,
            contentHash: current.contentHash,
            teamGenerationId: current.teamGenerationId,
            failureCode: null,
            failureDetail: null,
            failedAt: null,
            createdByUserId: context.user.id,
          },
        });
        if (count !== 1) throw new Error("reservation lost");
        return { kind: "send" as const, deliveryId: id };
      };
      const reserveNew = async () => {
        const row = await tx.messageDelivery.create({
          data: {
            groupId: activeGroupId,
            eventType: EVENT,
            channel: CHANNEL,
            destination: poll.chatId.toString(),
            telegramPollId: pollId,
            teamGenerationId: current.teamGenerationId,
            // M9-A — Match-linked polls make the teams post auditable per Match.
            matchId: poll.matchId ?? null,
            contentHash: current.contentHash,
            status: "SENDING",
            claimedAt: now,
            createdByUserId: context.user.id,
          },
          select: { id: true },
        });
        return { kind: "send" as const, deliveryId: row.id };
      };

      switch (state.kind) {
        case "not_posted":
          return reserveNew();
        case "failed":
          return reserveExisting(state.delivery.id);
        case "posted":
          return { kind: "already_posted", state };
        case "updated_available":
          return intent === "post_updated" ? reserveNew() : { kind: "reject", state };
        case "uncertain":
          return intent === "retry_uncertain" && deliveryId === state.delivery.id && (state.delivery.status === "UNCERTAIN" || isStaleSending(state.delivery, now))
            ? reserveExisting(state.delivery.id)
            : { kind: "reject", state };
        case "sending":
          return { kind: "reject", state };
      }
    });
  } catch {
    return NextResponse.json({ error: "Could not reserve the poll for posting. Nothing was sent." }, { status: 500 });
  }

  // Conflicting states are rejected before ANY Telegram side effect (including stopPoll).
  if (decision.kind === "reject") return stateResponse(decision.state, null, teamGenerationId);

  // --- 1. Telegram poll concern ---
  const closeStatus = await closeTelegramPoll(poll, activeGroupId);
  if (decision.kind === "already_posted") return stateResponse(decision.state, closeStatus, teamGenerationId);

  // --- 2. TEAMS_PUBLISHED delivery (exactly one send per reservation) ---
  // The link never changes the content hash (computed from `body`).
  // M9.2 — the Match's venue (📍 + maps link) is added to the sent text only, never to the hash.
  const venue = generation.matchId
    ? (await prisma.match.findFirst({ where: { id: generation.matchId, groupId: activeGroupId }, select: { venue: { select: { name: true, address: true } } } }))?.venue ?? null
    : null;
  const location = venue ? { name: venue.name, address: venue.address, mapsUrl: mapsUrl(venue.address) } : null;
  const html = view.url || location ? renderTelegramHtml(teamsContent({ type: "TEAMS_PUBLISHED", displayDate, teams, viewUrl: view.url, location })) : body;
  const reservedId = decision.deliveryId;

  let sent: { message_id?: unknown } | null;
  try {
    sent = await callTelegram("sendMessage", {
      chat_id: poll.chatId.toString(),
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e: unknown) {
    if (e instanceof TelegramApiRejectionError) {
      // Definite rejection: nothing was posted — retryable.
      await prisma.messageDelivery
        .updateMany({
          where: { id: reservedId, groupId: activeGroupId, status: "SENDING" },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            failureCode: "TELEGRAM_REJECTED",
            failureDetail: (e.description ?? e.message).slice(0, MAX_FAILURE_DETAIL),
          },
        })
        .catch(() => {
          // Left SENDING: becomes "uncertain" after STALE_SENDING_MS and needs an organizer.
        });
      return NextResponse.json(
        {
          ok: false,
          status: "telegram_rejected" satisfies CloseAndPostStatus,
          closeStatus,
          deliveryId: reservedId,
          telegramDescription: e.description,
          error: `Telegram rejected the teams message (${e.message}). Nothing was posted; you can retry after fixing the cause.`,
        },
        { status: 502 }
      );
    }

    // Ambiguous: Telegram may have delivered it. Never retried automatically.
    const failureCode =
      e instanceof TelegramAmbiguousError
        ? e.reason === "timeout"
          ? "TIMEOUT"
          : e.reason === "network"
            ? "NETWORK"
            : "UNREADABLE_RESPONSE"
        : "UNKNOWN";
    await prisma.messageDelivery
      .updateMany({
        where: { id: reservedId, groupId: activeGroupId, status: "SENDING" },
        data: { status: "UNCERTAIN", failedAt: new Date(), failureCode },
      })
      .catch(() => {
        // Left SENDING: treated as uncertain once stale.
      });
    return NextResponse.json(
      {
        ok: false,
        status: "delivery_unknown" satisfies CloseAndPostStatus,
        closeStatus,
        deliveryId: reservedId,
        error: `Could not confirm whether Telegram received the teams message. ${VERIFY_CHAT_MESSAGE}`,
      },
      { status: 502 }
    );
  }

  // --- confirm: SENDING(ours) → SENT, and keep the legacy columns in step ---
  const providerMessageId = typeof sent?.message_id === "number" || typeof sent?.message_id === "string" ? String(sent.message_id) : null;
  const confirmed = await prisma
    .$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.messageDelivery.updateMany({
        where: { id: reservedId, groupId: activeGroupId, status: "SENDING" },
        data: { status: "SENT", sentAt: now, providerMessageId },
      });
      if (count !== 1) return false;
      await tx.telegramPoll.updateMany({
        where: { pollId, groupId: activeGroupId },
        data: { teamsPostStatus: "POSTED", postedTeamGenerationId: teamGenerationId, teamsPostClaimedAt: now, teamsPostedAt: now },
      });
      return true;
    })
    .catch(() => false);

  if (!confirmed) {
    return NextResponse.json(
      {
        ok: false,
        status: "delivered_confirmation_failed" satisfies CloseAndPostStatus,
        closeStatus,
        error:
          "Telegram accepted the teams message, but it could not be recorded as posted. " +
          "Do not retry — the teams are already in the chat.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, status: "posted" satisfies CloseAndPostStatus, closeStatus, teamGenerationId });
}

/**
 * Delivery status for the organizer UI (read-only): the state plus the
 * actions that are safe in it. Never returns provider payloads.
 */
export async function getTeamsDeliveryStatusForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  // M9-A — Telegram (provider identity / external sends) is OWNER/ADMIN only.
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const url = new URL(req.url);
  const pollId = url.searchParams.get("pollId") ?? "";
  const teamGenerationId = url.searchParams.get("teamGenerationId") ?? "";
  if (!pollId || !teamGenerationId) return NextResponse.json({ error: "pollId and teamGenerationId are required" }, { status: 400 });

  const validated = await validatePostTarget(context, pollId, teamGenerationId);
  if (!validated.ok) return validated.response;

  const activeGroupId = context.activeGroup.id;
  const [rows, legacy, group] = await Promise.all([
    prisma.messageDelivery.findMany({ where: { groupId: activeGroupId, telegramPollId: pollId, channel: CHANNEL, eventType: EVENT }, select: DELIVERY_SELECT }),
    prisma.telegramPoll.findFirst({
      where: { pollId, groupId: activeGroupId },
      select: { teamsPostStatus: true, postedTeamGenerationId: true, teamsPostClaimedAt: true, teamsPostedAt: true, updatedAt: true },
    }),
    prisma.group.findFirst({ where: { id: activeGroupId }, select: { visibility: true } }),
  ]);
  // Dual-read without writing (GET): a legacy-only poll is evaluated as its
  // equivalent delivery record; the next post/recovery persists that row.
  const records: Array<DeliveryRecord & { attempts?: number; failureCode?: string | null }> =
    rows.length === 0 && legacy?.teamsPostStatus
      ? [
          {
            id: "",
            status: legacy.teamsPostStatus === "POSTED" ? "SENT" : "UNCERTAIN",
            contentHash: "legacy",
            teamGenerationId: legacy.postedTeamGenerationId,
            claimedAt: legacy.teamsPostClaimedAt ?? legacy.teamsPostedAt ?? legacy.updatedAt,
            sentAt: legacy.teamsPostedAt,
            createdAt: legacy.updatedAt,
            attempts: 1,
            failureCode: legacy.teamsPostStatus === "SENDING" ? "STALE_RESERVATION" : null,
          },
        ]
      : rows;
  const state = deliveryStateOf(records, validated.value.current);
  const delivery = ("delivery" in state ? state.delivery : null) as (DeliveryRecord & { attempts?: number; failureCode?: string | null }) | null;

  return NextResponse.json({
    state: state.kind,
    deliveryId: delivery?.id || null,
    attempts: delivery?.attempts ?? 0,
    sentAt: delivery?.sentAt ?? null,
    failureCode: delivery?.failureCode ?? null,
    visibility: group?.visibility ?? "PRIVATE",
  });
}

/**
 * Organizer recovery: confirm an uncertain (or stale) delivery that IS in
 * the Telegram chat. Never sends anything.
 */
export async function markTeamsDeliverySentForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  // M9-A — Telegram (provider identity / external sends) is OWNER/ADMIN only.
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const raw = await req.json().catch(() => null);
  const parsed = telegramDeliveryActionSchema.safeParse(raw ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const activeGroupId = context.activeGroup.id;

  const targetId = parsed.data.deliveryId;
  const target = await prisma.messageDelivery.findFirst({
    where: { id: targetId, groupId: activeGroupId, channel: CHANNEL, eventType: EVENT },
    select: { telegramPollId: true, teamGenerationId: true },
  });
  if (!target || !target.telegramPollId) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });
  const pollId = target.telegramPollId;

  const result = await prisma.$transaction(async (tx) => {
    await lockPoll(tx, pollId);
    const now = new Date();
    const rows = await tx.messageDelivery.findMany({
      where: { groupId: activeGroupId, telegramPollId: pollId, channel: CHANNEL, eventType: EVENT },
      select: DELIVERY_SELECT,
      orderBy: { createdAt: "desc" },
    });
    const latest = rows[0];
    if (!latest || latest.id !== targetId) return "not_latest" as const;
    if (!(latest.status === "UNCERTAIN" || isStaleSending(latest, now))) return "not_uncertain" as const;
    await tx.messageDelivery.update({
      where: { id: latest.id },
      data: { status: "SENT", sentAt: now, resolution: "MARKED_SENT", resolvedAt: now, resolvedByUserId: context.user.id },
    });
    await tx.telegramPoll.updateMany({
      where: { pollId, groupId: activeGroupId },
      data: {
        teamsPostStatus: "POSTED",
        ...(latest.teamGenerationId ? { postedTeamGenerationId: latest.teamGenerationId } : {}),
        teamsPostedAt: now,
      },
    });
    return "ok" as const;
  });

  if (result === "ok") return NextResponse.json({ ok: true, status: "marked_sent" });
  return NextResponse.json(
    { error: "Only the latest uncertain delivery can be marked as sent. Reload and check its status." },
    { status: 409 }
  );
}
