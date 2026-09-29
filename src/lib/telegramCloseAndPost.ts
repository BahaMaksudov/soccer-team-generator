import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatTeamsHtml, resolvePollDisplayDate } from "@/lib/telegramFormat";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { persistedTeamsSchema, telegramCloseAndPostSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.5D — canonical Close Poll + Post Teams.
 *
 * A separate, explicit operation (NOT part of Publish — canonical
 * Publish stays Telegram-free, allowTelegramPollActions: false):
 *
 *   validate → close poll → post teams
 *
 * Validation (all before any Telegram call or posting-state write):
 * poll and TeamGeneration are both loaded scoped to
 * context.activeGroup.id, the poll must have a pollDate, both dates
 * must be the same UTC calendar day, and the message is formatted
 * ONLY from the persisted TeamGeneration.teamsJson.
 *
 * Posting is guarded by a durable state machine on TelegramPoll:
 *
 *   NULL ──(atomic conditional claim, count===1)──▶ SENDING
 *   SENDING ──(confirmed sendMessage success)──▶ POSTED
 *   SENDING ──(definite Telegram rejection, ok:false)──▶ NULL
 *
 * An ambiguous send failure leaves SENDING in place: Telegram may have
 * delivered the message, so nothing ever resends automatically — an
 * Admin must verify the chat. Historical rows are NULL, which means
 * "no canonical durable posting record", not "never posted".
 *
 * Legacy Publish (src/lib/publishTeams.ts) is not touched and does not
 * read or write any of this state.
 *
 * Deliberate, approved D.5D behavior: Publish upserts TeamGeneration on
 * (groupId, date), so republishing a date with different teams keeps
 * the same id. Once that id is POSTED, Close/Post returns
 * already_posted and never sends the revised teams — no change
 * detection is attempted. Delivering corrected teams needs a future,
 * explicit versioning design.
 *
 * Canonical Telegram side effects are ONLY stopPoll and the formatted
 * teams message — unlike legacy Publish, no extra "✅ Poll is closed"
 * chat message is sent.
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
  | "already_posted_different_generation"
  | "post_in_progress_or_unknown"
  | "claim_conflict"
  | "telegram_rejected"
  | "delivery_unknown"
  | "delivered_confirmation_failed";

const VERIFY_CHAT_MESSAGE =
  "A previous attempt to post teams for this poll may have reached Telegram. " +
  "Check the Telegram chat before doing anything else — do not retry automatically.";

type PostState = {
  teamsPostStatus: "SENDING" | "POSTED" | null;
  postedTeamGenerationId: string | null;
};

/**
 * Maps an existing (non-NULL) posting state to its response, or returns
 * null when the state is NULL (the caller may try to claim).
 */
function existingStateResponse(
  state: PostState,
  teamGenerationId: string,
  closeStatus: CloseStatus | null
): NextResponse | null {
  if (state.teamsPostStatus === "POSTED") {
    if (state.postedTeamGenerationId === teamGenerationId) {
      return NextResponse.json({
        ok: true,
        status: "already_posted" satisfies CloseAndPostStatus,
        closeStatus,
        teamGenerationId,
      });
    }
    return NextResponse.json(
      {
        ok: false,
        status: "already_posted_different_generation" satisfies CloseAndPostStatus,
        closeStatus,
        error:
          "Teams from a different published generation were already posted for this poll. " +
          "Nothing was sent.",
      },
      { status: 409 }
    );
  }
  if (state.teamsPostStatus === "SENDING") {
    return NextResponse.json(
      {
        ok: false,
        status: "post_in_progress_or_unknown" satisfies CloseAndPostStatus,
        closeStatus,
        error: VERIFY_CHAT_MESSAGE,
      },
      { status: 409 }
    );
  }
  return null;
}

export async function closePollAndPostTeamsForContext(
  context: TenantContext,
  req: Request
): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  // --- 2. body ---
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = telegramCloseAndPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }
  const { pollId, teamGenerationId } = parsed.data;

  // --- 3. poll, scoped to the active Group (foreign == missing) ---
  const poll = await prisma.telegramPoll.findFirst({
    where: { pollId, groupId: activeGroupId },
    select: {
      pollId: true,
      chatId: true,
      messageId: true,
      question: true,
      pollDate: true,
      isClosed: true,
      teamsPostStatus: true,
      postedTeamGenerationId: true,
    },
  });
  if (!poll) {
    return NextResponse.json({ error: "Poll not found" }, { status: 404 });
  }

  // --- 4. TeamGeneration, scoped to the active Group (foreign == missing) ---
  const generation = await prisma.teamGeneration.findFirst({
    where: { id: teamGenerationId, groupId: activeGroupId },
    select: { id: true, date: true, teamsJson: true },
  });
  if (!generation) {
    return NextResponse.json({ error: "Published teams not found" }, { status: 404 });
  }

  // --- 5. pollDate required: no question-text fallback for this action ---
  if (!poll.pollDate) {
    return NextResponse.json(
      { error: "This poll has no poll date, so it cannot be matched to published teams." },
      { status: 400 }
    );
  }

  // --- 6. same UTC calendar day ---
  if (toDateOnlyUTC(poll.pollDate).getTime() !== toDateOnlyUTC(generation.date).getTime()) {
    return NextResponse.json(
      { error: "The poll date does not match the published teams date." },
      { status: 400 }
    );
  }

  // --- 7. persisted teams only ---
  let teams;
  try {
    const result = persistedTeamsSchema.safeParse(JSON.parse(generation.teamsJson));
    if (!result.success) throw new Error("invalid");
    teams = result.data;
  } catch {
    return NextResponse.json(
      { error: "The published teams could not be read. Re-publish before posting." },
      { status: 422 }
    );
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: "Missing TELEGRAM_BOT_TOKEN" }, { status: 500 });
  }

  // Conflicting states are rejected before ANY Telegram side effect
  // (including stopPoll). NULL and POSTED-same-generation proceed.
  const preState: PostState = {
    teamsPostStatus: poll.teamsPostStatus,
    postedTeamGenerationId: poll.postedTeamGenerationId,
  };
  const isPostedSame =
    preState.teamsPostStatus === "POSTED" && preState.postedTeamGenerationId === teamGenerationId;
  if (preState.teamsPostStatus !== null && !isPostedSame) {
    return existingStateResponse(preState, teamGenerationId, null)!;
  }

  const chatId = poll.chatId.toString();

  // --- close ---
  // A close failure does NOT block posting: stopPoll and sendMessage
  // are independent Bot API calls, and a still-open poll does not make
  // posting the teams message unsafe. The outcome is reported.
  let closeStatus: CloseStatus;
  if (poll.isClosed) {
    closeStatus = "already_closed_locally";
  } else if (poll.messageId == null) {
    closeStatus = "missing_message_id";
  } else {
    try {
      await callTelegram("stopPoll", { chat_id: chatId, message_id: Number(poll.messageId) });
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
        .updateMany({ where: { pollId, groupId: activeGroupId }, data: { isClosed: true } })
        .catch(() => {
          // Telegram is the source of truth for the poll being closed;
          // a failed local sync is reconciled on the next attempt.
        });
    }
  }

  if (isPostedSame) {
    return existingStateResponse(preState, teamGenerationId, closeStatus)!;
  }

  // --- atomic conditional claim: only count===1 may send ---
  let claimCount: number;
  try {
    const claim = await prisma.telegramPoll.updateMany({
      where: { pollId, groupId: activeGroupId, teamsPostStatus: null },
      data: {
        teamsPostStatus: "SENDING",
        postedTeamGenerationId: teamGenerationId,
        teamsPostClaimedAt: new Date(),
      },
    });
    claimCount = claim.count;
  } catch {
    return NextResponse.json(
      { error: "Could not reserve the poll for posting. Nothing was sent.", closeStatus },
      { status: 500 }
    );
  }

  if (claimCount !== 1) {
    // Someone else changed the state between our read and our claim.
    // Re-read and resolve — never retry the claim blindly.
    const current = await prisma.telegramPoll.findFirst({
      where: { pollId, groupId: activeGroupId },
      select: { teamsPostStatus: true, postedTeamGenerationId: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Poll not found" }, { status: 404 });
    }
    return (
      existingStateResponse(current, teamGenerationId, closeStatus) ??
      NextResponse.json(
        {
          ok: false,
          status: "claim_conflict" satisfies CloseAndPostStatus,
          closeStatus,
          error: "The posting state for this poll changed during the request. Nothing was sent. Reload and try again.",
        },
        { status: 409 }
      )
    );
  }

  // --- send (exactly once per successful claim) ---
  const displayDate = resolvePollDisplayDate(poll, null);
  const html = formatTeamsHtml(displayDate, teams);

  try {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e: unknown) {
    if (e instanceof TelegramApiRejectionError) {
      // Definite rejection: release OUR claim only, so a later explicit
      // retry is possible. teamsPostedAt was never set.
      const released = await prisma.telegramPoll
        .updateMany({
          where: {
            pollId,
            groupId: activeGroupId,
            teamsPostStatus: "SENDING",
            postedTeamGenerationId: teamGenerationId,
          },
          data: { teamsPostStatus: null, postedTeamGenerationId: null, teamsPostClaimedAt: null },
        })
        .then((r) => r.count === 1)
        .catch(() => false);

      return NextResponse.json(
        {
          ok: false,
          status: "telegram_rejected" satisfies CloseAndPostStatus,
          closeStatus,
          claimReleased: released,
          telegramDescription: e.description,
          error: released
            ? `Telegram rejected the teams message (${e.message}). Nothing was posted; you can retry after fixing the cause.`
            : `Telegram rejected the teams message (${e.message}), but the posting lock could not be released. ${VERIFY_CHAT_MESSAGE}`,
        },
        { status: 502 }
      );
    }

    // Ambiguous: leave SENDING in place. Never retry automatically.
    return NextResponse.json(
      {
        ok: false,
        status: "delivery_unknown" satisfies CloseAndPostStatus,
        closeStatus,
        error: `Could not confirm whether Telegram received the teams message. ${VERIFY_CHAT_MESSAGE}`,
      },
      { status: 502 }
    );
  }

  // --- confirm: SENDING(ours) → POSTED ---
  const confirmed = await prisma.telegramPoll
    .updateMany({
      where: {
        pollId,
        groupId: activeGroupId,
        teamsPostStatus: "SENDING",
        postedTeamGenerationId: teamGenerationId,
      },
      data: { teamsPostStatus: "POSTED", teamsPostedAt: new Date() },
    })
    .then((r) => r.count === 1)
    .catch(() => false);

  if (!confirmed) {
    // Telegram accepted the message; only the local record is off.
    // Never send again from here.
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

  return NextResponse.json({
    ok: true,
    status: "posted" satisfies CloseAndPostStatus,
    closeStatus,
    teamGenerationId,
  });
}
