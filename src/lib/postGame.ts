import { NextResponse } from "next/server";
import type { MessageEventType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { isManager, managersOnlyResponse } from "@/lib/tenantRoute";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { findSport } from "@/lib/sports";
import { postGameSchema, zodErrorResponse } from "@/lib/validation";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";
import { renderTelegramPoll } from "@/lib/messaging/telegram";
import { mvpPollContent, MVP_POLL_MAX_OPTIONS } from "@/lib/messaging/content";
import { renderSummaryMessage, type PostGameFacts } from "@/lib/messaging/postGameMessages";
import { summaryReadiness, type SummaryReadiness } from "@/lib/matchSummaryReadiness";
import type { z } from "zod";
import { sportMessaging } from "@/lib/sports";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { resolveViewUrl } from "@/lib/telegramCloseAndPost";
import { aiConfigured } from "@/lib/ai/openai";
import { participantsOf } from "@/lib/matchParticipants";
import { applyTelegramMvpAnswer } from "@/lib/telegramMvp";
import { buildRecapFacts, deterministicRecap, generateAiRecap, RECAP_MAX_LENGTH, sanitizeRecapText, type RecapFacts } from "@/lib/recap";
import { fixturePairs, fixtureWinner, isCompleteFor, parseResult, serializeFixtures, validateFixtures, type FixtureInput, type MatchResultData } from "@/lib/matchResults";

/**
 * M9-D — post-game lifecycle of a Match: result, MVP voting, recap.
 *
 *   SAVE ≠ PUBLISH ≠ SEND. Saving stores organizer-only data; publishing makes
 *   it visible on the Match page; ONLY the explicit "post_message"/"start_mvp"
 *   actions talk to Telegram (OWNER/ADMIN, MessageDelivery-idempotent). AI
 *   only drafts recap prose from verified facts; it never sets a score or an
 *   MVP, never publishes and never sends.
 *
 * Roles: data actions (result, recap, publish MVP) follow Match editing (any
 * organization member, like Generate/Publish teams); Telegram actions (MVP
 * poll, close MVP poll, posts) are OWNER/ADMIN. Every id is resolved inside
 * the URL-bound Group (foreign == 404). A canceled Match accepts no post-game
 * action. Services are plain functions so a future agent can call them.
 */

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
const NOT_FOUND = () => fail("Match not found", 404);

export { participantsOf, applyTelegramMvpAnswer };
// M8.1 — results are pairwise fixtures (src/lib/matchResults.ts); 2-team rows keep the historical format.
export { parseResult };

const teamNumbersOf = (participants: Array<{ teamNumber: number }>) => [...new Set(participants.map((p) => p.teamNumber))].sort((a, b) => a - b);

async function loadMatch(context: TenantContext, matchId: string) {
  return prisma.match.findFirst({
    where: { id: matchId, groupId: context.activeGroup.id },
    select: {
      id: true,
      date: true,
      startTime: true,
      locationName: true,
      status: true,
      telegramChatId: true,
      generation: { select: { teamsJson: true, groupId: true } },
      result: true,
      mvp: true,
      recap: true,
    },
  });
}
type LoadedMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

// ------------------------------------------------------------------ MVP tally

export type MvpTally = { counts: Array<{ playerId: string; votes: number }>; valid: number; leaders: string[] };

/** Deterministic: only participant voters, only candidates, never self. Ties → several leaders. */
export async function tallyMvp(groupId: string, matchId: string, candidates: string[], participants: Set<string>): Promise<MvpTally> {
  const votes = await prisma.matchMvpVote.findMany({ where: { matchId, groupId }, select: { voterPlayerId: true, candidatePlayerId: true } });
  const candidateSet = new Set(candidates);
  const counts = new Map(candidates.map((c) => [c, 0]));
  let valid = 0;
  for (const v of votes) {
    if (!participants.has(v.voterPlayerId) || !candidateSet.has(v.candidatePlayerId) || v.voterPlayerId === v.candidatePlayerId) continue;
    counts.set(v.candidatePlayerId, (counts.get(v.candidatePlayerId) ?? 0) + 1);
    valid++;
  }
  const top = Math.max(0, ...counts.values());
  return {
    counts: candidates.map((c) => ({ playerId: c, votes: counts.get(c) ?? 0 })),
    valid,
    leaders: top > 0 ? candidates.filter((c) => counts.get(c) === top) : [],
  };
}

// ------------------------------------------------------------------ MVP method

type MvpRow = { method: "PLAYER_VOTE" | "ORGANIZER_SELECTION" | null; openedAt: Date | null } | null;

/**
 * A player vote is "started" (and the method locked to PLAYER_VOTE) once its
 * Telegram poll may have reached the chat: voting opened, or a poll delivery
 * is SENDING / SENT / UNCERTAIN. A definitively FAILED attempt does not lock.
 */
export async function playerVoteLocked(groupId: string, matchId: string, mvp: MvpRow): Promise<boolean> {
  if (mvp?.openedAt) return true;
  const n = await prisma.messageDelivery.count({ where: { matchId, groupId, eventType: "MVP_POLL_POSTED", status: { in: ["SENDING", "SENT", "UNCERTAIN"] } } });
  return n > 0;
}

/** The Match's Player-of-the-Match method (rows from before the method column: a started vote = PLAYER_VOTE). */
export function effectiveMvpMethod(mvp: MvpRow, voteLocked: boolean): "PLAYER_VOTE" | "ORGANIZER_SELECTION" | null {
  if (voteLocked) return "PLAYER_VOTE";
  return mvp?.method ?? null;
}

// ------------------------------------------------------------------ deliveries

type Intent = "post" | "post_updated" | "retry_uncertain";
type Reserve = { kind: "send"; deliveryId: string } | { kind: "respond"; response: NextResponse };

/** Same reserve → send → finalize state machine as attendance polls (per Match + event + destination, under a lock). */
async function reserveDelivery(
  context: TenantContext,
  matchId: string,
  event: MessageEventType,
  destination: string,
  contentHash: string,
  intent: Intent,
  // Hashes meaning "this content was already posted" (defaults to the stored one).
  acceptedHashes: string[] = [contentHash]
): Promise<Reserve> {
  const groupId = context.activeGroup.id;
  return prisma.$transaction(async (tx): Promise<Reserve> => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`match-msg:${matchId}:${event}`}))`;
    const latest = await tx.messageDelivery.findFirst({
      where: { matchId, groupId, eventType: event, channel: "TELEGRAM", destination },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, contentHash: true, claimedAt: true },
    });
    const now = new Date();
    const respond = (status: number, body: object): Reserve => ({ kind: "respond", response: NextResponse.json(body, { status }) });
    const reserveNew = async (): Promise<Reserve> => ({
      kind: "send",
      deliveryId: (
        await tx.messageDelivery.create({
          data: { groupId, matchId, eventType: event, channel: "TELEGRAM", destination, contentHash, status: "SENDING", claimedAt: now, createdByUserId: context.user.id },
          select: { id: true },
        })
      ).id,
    });
    const reserveExisting = async (id: string): Promise<Reserve> => {
      await tx.messageDelivery.update({
        where: { id },
        data: { status: "SENDING", attempts: { increment: 1 }, claimedAt: now, contentHash, failureCode: null, failureDetail: null, failedAt: null, createdByUserId: context.user.id },
      });
      return { kind: "send", deliveryId: id };
    };
    if (!latest) return reserveNew();
    const stale = latest.status === "SENDING" && now.getTime() - latest.claimedAt.getTime() > STALE_SENDING_MS;
    if (latest.status === "SENDING" && !stale) return respond(409, { error: "This is being posted right now.", state: "sending" });
    if (latest.status === "UNCERTAIN" || stale) {
      if (intent !== "retry_uncertain") return respond(409, { error: "The last attempt may or may not have reached Telegram. Check the Telegram group before retrying.", state: "uncertain" });
      return reserveExisting(latest.id);
    }
    if (latest.status === "FAILED") return reserveExisting(latest.id);
    const same = acceptedHashes.includes(latest.contentHash);
    if (same && intent !== "post_updated") return respond(200, { ok: true, state: "already_posted" });
    if (!same && intent !== "post_updated") return respond(409, { error: "This changed since it was posted. Post the update?", state: "updated_available" });
    return reserveNew();
  });
}

async function sendReserved(deliveryId: string, send: () => Promise<{ message_id?: number; poll?: { id?: string } }>) {
  try {
    const sent = await send();
    if (!sent?.message_id) {
      await prisma.messageDelivery.update({ where: { id: deliveryId }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: "UNREADABLE" } });
      return { ok: false as const, response: fail("Telegram did not confirm the message. Check the group before retrying.", 502, { state: "uncertain" }) };
    }
    return { ok: true as const, sent };
  } catch (e) {
    const definite = e instanceof TelegramApiRejectionError;
    await prisma.messageDelivery.update({
      where: { id: deliveryId },
      data: definite
        ? { status: "FAILED", failedAt: new Date(), failureCode: "TELEGRAM_REJECTED", failureDetail: e.description?.slice(0, 300) ?? null }
        : { status: "UNCERTAIN", failedAt: new Date(), failureCode: "AMBIGUOUS" },
    });
    return {
      ok: false as const,
      response: definite
        ? fail("Telegram rejected the message. You can try again.", 502, { state: "failed" })
        : fail("Telegram did not confirm the message. Check the group before retrying.", 502, { state: "uncertain" }),
    };
  }
}

/** Organizer-facing state of one post-game message (mirrors the teams delivery labels). */
async function messageState(groupId: string, matchId: string, event: MessageEventType, destination: string | null, acceptedHashes: string[] | null) {
  if (!destination) return null;
  const latest = await prisma.messageDelivery.findMany({
    where: { matchId, groupId, eventType: event, channel: "TELEGRAM", destination },
    orderBy: { createdAt: "desc" },
    select: { status: true, contentHash: true, claimedAt: true },
  });
  if (latest.length === 0) return "not_posted";
  const head = latest[0];
  if (head.status === "SENDING") return Date.now() - head.claimedAt.getTime() > STALE_SENDING_MS ? "uncertain" : "sending";
  if (head.status === "UNCERTAIN") return "uncertain";
  if (acceptedHashes && latest.some((d) => d.status === "SENT" && acceptedHashes.includes(d.contentHash))) return "posted";
  if (head.status === "FAILED") return "failed";
  return latest.some((d) => d.status === "SENT") ? "updated_available" : "not_posted";
}

async function matchDestination(groupId: string, telegramChatId: number | null) {
  if (!telegramChatId) return null;
  const chat = await prisma.telegramChat.findFirst({ where: { id: telegramChatId, groupId, disconnectedAt: null }, select: { chatId: true } });
  return chat ? chat.chatId.toString() : null;
}

// ------------------------------------------------------------------ content (published data only)

function mvpNames(m: LoadedMatch): string[] {
  if (!m.mvp?.publishedAt) return [];
  const byId = new Map(participantsOf(m.generation?.teamsJson).map((p) => [p.playerId, p.name]));
  return m.mvp.winnerPlayerIds.map((id) => byId.get(id) ?? "Player");
}

function recapFactsOf(m: LoadedMatch, sportKey: string): RecapFacts | null {
  if (!m.result?.publishedAt) return null;
  return buildRecapFacts({
    sportLabel: findSport(sportKey)?.label ?? "",
    date: formatYMDFromDate(m.date),
    locationName: m.locationName,
    result: parseResult(m.result.scoresJson),
    mvpNames: mvpNames(m),
    participantCount: participantsOf(m.generation?.teamsJson).length,
  });
}

type OutgoingMessage = { html: string; contentHash: string; acceptedHashes: string[] };

function factsOf(m: LoadedMatch, sportKey: string): PostGameFacts {
  return {
    date: formatYMDFromDate(m.date),
    sportEmoji: sportMessaging(sportKey).emoji,
    result: parseResult(m.result?.scoresJson),
    venue: m.locationName?.trim() || null,
  };
}

/**
 * The Match Summary — THE only post-game Telegram message (M9-D
 * consolidation): ONLY canonical PUBLISHED data. Needs a published result;
 * a published Player of the Match / recap is included when present; drafts,
 * saved-but-unpublished recaps and unpublished selections never are.
 */
function summaryMessage(m: LoadedMatch, viewUrl: string | null, sportKey: string): OutgoingMessage | string {
  if (!m.result?.publishedAt) return "Publish the result before posting the match summary.";
  // M9.1 — the PUBLISHED recap (publishedContent), never the saved working copy.
  const recap = m.recap?.publishedAt && m.recap.publishedContent ? m.recap.publishedContent : null;
  return renderSummaryMessage({ ...factsOf(m, sportKey), mvpNames: mvpNames(m), recap }, viewUrl);
}

// ------------------------------------------------------------------ actions

export type PostGameCommand = z.infer<typeof postGameSchema>;

/** HTTP entry: parse + validate, then the canonical operation. */
export async function postGameAction(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const parsed = postGameSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  return runPostGameAction(context, matchId, parsed.data);
}

/**
 * THE authoritative post-game operations (save/publish result, start/close
 * vote, save/reset/publish Player of the Match, generate/save/publish recap,
 * post Match Summary). The organizer UI and any future agent/automation call
 * this same function with the same TenantContext authorization — there is no
 * separate "agent" implementation. Nothing here cascades: each command does
 * exactly one thing, and only "start_mvp" / "post_message" talk to Telegram.
 */
export async function runPostGameAction(context: TenantContext, matchId: string, command: PostGameCommand): Promise<NextResponse> {
  const body = command;
  const groupId = context.activeGroup.id;
  // UI-4A — every post-game command (result, Player of the Match, recap, Match
  // Summary) is an organizer mutation: OWNER/ADMIN only; MEMBER gets the generic
  // 404. Player voting is NOT a command here — it arrives through the Telegram
  // poll (src/lib/telegramMvp.ts) and keeps its own participant rules.
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const m = await loadMatch(context, matchId);
  if (!m) return NOT_FOUND();
  if (m.status === "CANCELED") return fail("This match is canceled. Reopen it before recording post-game details.");
  const participants = participantsOf(m.generation?.teamsJson);
  const participantIds = new Set(participants.map((p) => p.playerId));
  const voteLocked = await playerVoteLocked(groupId, m.id, m.mvp);
  const method = effectiveMvpMethod(m.mvp, voteLocked);

  switch (body.action) {
    // ---------------- result
    case "save_result": {
      if (participants.length === 0) return fail("Publish the teams for this match first.");
      const teamNumbers = teamNumbersOf(participants);
      if (Boolean(body.fixtures) === Boolean(body.scores)) return fail("Send the result as one score pair per fixture.");
      let input: FixtureInput[];
      if (body.scores) {
        // Pre-M8.1 shape (one score per team): only meaningful for exactly two teams.
        const given = [...body.scores].sort((a, b) => a.teamNumber - b.teamNumber);
        if (teamNumbers.length !== 2 || given.length !== 2 || given.some((s, i) => s.teamNumber !== teamNumbers[i])) {
          return fail(teamNumbers.length === 2 ? "Enter one score for each published team." : "Enter a score for every fixture.");
        }
        input = [{ teamA: given[0].teamNumber, teamB: given[1].teamNumber, scoreA: given[0].score, scoreB: given[1].score }];
      } else {
        input = body.fixtures!;
      }
      // Team numbers are checked against THIS match's published team set (never trusted from the browser).
      const checked = validateFixtures(teamNumbers, input);
      if (!checked.ok) return fail(checked.error);
      const scoresJson = serializeFixtures(checked.fixtures);
      await prisma.matchResult.upsert({
        where: { matchId: m.id },
        update: { scoresJson, updatedByUserId: context.user.id },
        create: { matchId: m.id, groupId, scoresJson, updatedByUserId: context.user.id },
      });
      return NextResponse.json({ ok: true, published: Boolean(m.result?.publishedAt) });
    }
    case "publish_result": {
      if (!m.result) return fail("Save the result first.");
      // M8.1 — the whole fixture set is published at once, and only when complete for the published teams.
      if (!m.result.publishedAt && !isCompleteFor(parseResult(m.result.scoresJson), teamNumbersOf(participants))) {
        return fail("Enter a score for every fixture before publishing the result.");
      }
      const now = new Date();
      await prisma.$transaction([
        prisma.matchResult.update({ where: { matchId: m.id }, data: { publishedAt: m.result.publishedAt ?? now, publishedByUserId: context.user.id } }),
        // A published final result completes a scheduled Match (status only; nothing is sent).
        prisma.match.updateMany({ where: { id: m.id, groupId, status: "SCHEDULED" }, data: { status: "COMPLETED" } }),
      ]);
      return NextResponse.json({ ok: true });
    }

    // ---------------- MVP
    case "start_mvp": {
      if (participants.length < 2) return fail("Publish the teams for this match first.");
      if (!m.result?.publishedAt) return fail("Publish the final result before starting the MVP vote.");
      if (m.mvp?.closedAt) return fail("The MVP vote for this match is closed.");
      if (m.mvp?.publishedAt) return fail("Player of the Match is already published for this match.", 409, { code: "MVP_LOCKED" });
      if (method === "ORGANIZER_SELECTION") {
        return fail("An organizer selection is saved for this match. Reset it before starting a player vote.", 409, { code: "MVP_METHOD_LOCKED" });
      }
      const destination = await matchDestination(groupId, m.telegramChatId);
      if (!destination) return fail("Choose a connected Telegram group for this match first.");
      let candidates = m.mvp?.candidatePlayerIds?.length ? m.mvp.candidatePlayerIds : null;
      if (body.candidateIds) {
        const unique = [...new Set(body.candidateIds)];
        if (unique.some((id) => !participantIds.has(id))) return fail("Candidates must be players of this match's published teams.", 404);
        if (candidates && candidates.join() !== unique.join()) return fail("The MVP vote already started with other candidates.", 409);
        candidates = unique;
      }
      if (!candidates) {
        if (participants.length > MVP_POLL_MAX_OPTIONS) {
          return fail(`A Telegram poll can list at most ${MVP_POLL_MAX_OPTIONS} players. Choose a shortlist of candidates.`, 400, { code: "SHORTLIST_REQUIRED" });
        }
        candidates = participants.map((p) => p.playerId);
      }
      if (candidates.length < 2 || candidates.length > MVP_POLL_MAX_OPTIONS) return fail(`Choose between 2 and ${MVP_POLL_MAX_OPTIONS} candidates.`);
      // Option text = display name; duplicates are disambiguated by team so every option is distinct.
      const byId = new Map(participants.map((p) => [p.playerId, p]));
      const raw = candidates.map((id) => byId.get(id)!);
      const names = raw.map((p) => (raw.filter((q) => q.name === p.name).length > 1 ? `${p.name} (Team ${p.teamNumber})` : p.name));
      const content = mvpPollContent({ date: formatYMDFromDate(m.date), names });
      const contentHash = contentHashOf(JSON.stringify({ destination, question: content.question, options: content.options }));
      // Candidates are stored BEFORE the send so option index → Player is known for every answer.
      await prisma.matchMvp.upsert({
        where: { matchId: m.id },
        update: { candidatePlayerIds: candidates, method: "PLAYER_VOTE" },
        create: { matchId: m.id, groupId, candidatePlayerIds: candidates, method: "PLAYER_VOTE" },
      });
      const decision = await reserveDelivery(context, m.id, "MVP_POLL_POSTED", destination, contentHash, body.intent);
      if (decision.kind === "respond") return decision.response;
      const sent = await sendReserved(decision.deliveryId, () => callTelegram("sendPoll", { chat_id: destination, ...renderTelegramPoll(content) }));
      if (!sent.ok) return sent.response;
      const pollId = sent.sent.poll?.id ? String(sent.sent.poll.id) : null;
      if (!pollId) {
        await prisma.messageDelivery.update({ where: { id: decision.deliveryId }, data: { status: "UNCERTAIN", failedAt: new Date(), failureCode: "UNREADABLE" } });
        return fail("Telegram did not confirm the poll. Check the group before retrying.", 502, { state: "uncertain" });
      }
      await prisma.$transaction(async (tx) => {
        await tx.telegramPoll.create({
          data: { pollId, chatId: BigInt(destination), messageId: BigInt(sent.sent.message_id!), question: content.question, optionsJson: JSON.stringify(content.options), pollDate: m.date, isClosed: false, groupId, matchId: m.id, kind: "MVP" },
        });
        await tx.matchMvp.update({ where: { matchId: m.id }, data: { openedAt: m.mvp?.openedAt ?? new Date(), openedByUserId: context.user.id } });
        await tx.messageDelivery.update({ where: { id: decision.deliveryId }, data: { status: "SENT", sentAt: new Date(), providerMessageId: String(sent.sent.message_id), telegramPollId: pollId } });
      });
      return NextResponse.json({ ok: true, state: "posted" }, { status: 201 });
    }
    case "close_mvp": {
      if (!m.mvp?.openedAt) return fail("The MVP vote has not started.");
      if (m.mvp.closedAt) return NextResponse.json({ ok: true, state: "already_closed" });
      const polls = await prisma.telegramPoll.findMany({ where: { matchId: m.id, groupId, kind: "MVP" }, select: { pollId: true, chatId: true, messageId: true, isClosed: true } });
      const answers = await prisma.telegramPollAnswer.findMany({ where: { groupId, pollId: { in: polls.map((p) => p.pollId) } }, orderBy: { updatedAt: "asc" }, select: { userId: true, optionIdsJson: true } });
      // Recovery replay of stored answers (same mapping as the webhook), then freeze.
      await prisma.$transaction(async (tx) => {
        for (const a of answers) {
          let optionIds: unknown = [];
          try {
            optionIds = JSON.parse(a.optionIdsJson);
          } catch {
            optionIds = [];
          }
          await applyTelegramMvpAnswer(tx, { matchId: m.id, groupId, telegramUserId: a.userId, optionIds, allowClosed: true });
        }
        await tx.matchMvp.update({ where: { matchId: m.id }, data: { closedAt: new Date() } });
      });
      // Best effort: stop the Telegram poll(s). Not a message; failures don't reopen voting.
      for (const p of polls) {
        if (p.isClosed || !p.messageId) continue;
        try {
          await callTelegram("stopPoll", { chat_id: p.chatId.toString(), message_id: Number(p.messageId) });
          await prisma.telegramPoll.update({ where: { pollId: p.pollId }, data: { isClosed: true } });
        } catch {
          /* the official tally is already frozen */
        }
      }
      return NextResponse.json({ ok: true, state: "closed" });
    }
    case "save_mvp_selection": {
      if (!m.result?.publishedAt) return fail("Publish the final result before choosing Player of the Match.");
      if (m.mvp?.publishedAt) return fail("Player of the Match is already published for this match.", 409, { code: "MVP_LOCKED" });
      if (voteLocked) return fail("A player vote has already started for this match; it can't be replaced by an organizer selection.", 409, { code: "MVP_METHOD_LOCKED" });
      // Only a Player of this Match's PUBLISHED teams (foreign/unknown ids are indistinguishable).
      if (!participantIds.has(body.playerId)) return fail("Player not found", 404);
      await prisma.matchMvp.upsert({
        where: { matchId: m.id },
        update: { method: "ORGANIZER_SELECTION", selectedPlayerId: body.playerId, selectedByUserId: context.user.id, selectedAt: new Date() },
        create: { matchId: m.id, groupId, method: "ORGANIZER_SELECTION", selectedPlayerId: body.playerId, selectedByUserId: context.user.id, selectedAt: new Date() },
      });
      return NextResponse.json({ ok: true, published: false });
    }
    case "reset_mvp_selection": {
      if (m.mvp?.publishedAt) return fail("Player of the Match is already published for this match.", 409, { code: "MVP_LOCKED" });
      if (method !== "ORGANIZER_SELECTION") return fail("There is no organizer selection to reset.");
      await prisma.matchMvp.update({ where: { matchId: m.id }, data: { method: null, selectedPlayerId: null, selectedByUserId: null, selectedAt: null } });
      return NextResponse.json({ ok: true });
    }
    case "publish_mvp": {
      if (method === "ORGANIZER_SELECTION") {
        const denied = managersOnlyResponse(context);
        if (denied) return denied;
        const selected = m.mvp?.selectedPlayerId;
        if (!selected || !participantIds.has(selected)) return fail("Save a Player of the Match selection first.");
        await prisma.matchMvp.update({
          where: { matchId: m.id },
          // decision stays NULL: it only describes how a PLAYER_VOTE was resolved.
          data: { winnerPlayerIds: [selected], decision: null, publishedAt: m.mvp!.publishedAt ?? new Date(), publishedByUserId: context.user.id },
        });
        return NextResponse.json({ ok: true, method });
      }
      if (!m.mvp?.closedAt) return fail("Close the MVP vote first.");
      const tally = await tallyMvp(groupId, m.id, m.mvp.candidatePlayerIds, participantIds);
      if (tally.leaders.length === 0) return fail("There are no valid MVP votes.");
      let winners: string[];
      let decision: "VOTES" | "CO_MVP" | "ORGANIZER_TIEBREAK";
      if (tally.leaders.length === 1) {
        winners = tally.leaders;
        decision = "VOTES";
      } else if (body.tieBreak?.mode === "co") {
        winners = tally.leaders;
        decision = "CO_MVP";
      } else if (body.tieBreak?.mode === "pick") {
        if (!tally.leaders.includes(body.tieBreak.playerId)) return fail("Pick one of the tied players.");
        winners = [body.tieBreak.playerId];
        decision = "ORGANIZER_TIEBREAK";
      } else {
        return fail("The vote is tied. Publish co-MVPs or pick one of the tied players.", 409, { code: "TIED" });
      }
      await prisma.matchMvp.update({
        where: { matchId: m.id },
        data: { winnerPlayerIds: winners, decision, publishedAt: m.mvp.publishedAt ?? new Date(), publishedByUserId: context.user.id },
      });
      return NextResponse.json({ ok: true, decision });
    }

    // ---------------- recap
    case "generate_recap": {
      const facts = recapFactsOf(m, context.activeGroup.sportKey);
      if (!facts) return fail("Publish the final result before generating a recap.");
      const ai = await generateAiRecap(facts);
      if (!ai.ok) return fail(ai.message, 503, { code: ai.code, fallback: deterministicRecap(facts) });
      await prisma.matchRecap.upsert({
        where: { matchId: m.id },
        update: { generatedContent: ai.text, generatedAt: new Date(), generatedByUserId: context.user.id },
        create: { matchId: m.id, groupId, generatedContent: ai.text, generatedAt: new Date(), generatedByUserId: context.user.id },
      });
      // Returned for review only — not saved as the recap, not published, not sent.
      return NextResponse.json({ ok: true, text: ai.text });
    }
    case "save_recap": {
      const content = sanitizeRecapText(body.content);
      if (!content) return fail("The recap is empty.");
      if (content.length > RECAP_MAX_LENGTH) return fail(`Keep the recap under ${RECAP_MAX_LENGTH} characters.`);
      const facts = recapFactsOf(m, context.activeGroup.sportKey);
      const generated = m.recap?.generatedContent ?? null;
      const source = generated && content === generated ? "AI" : facts && content === deterministicRecap(facts) ? "DETERMINISTIC" : generated ? "AI_EDITED" : "MANUAL";
      await prisma.matchRecap.upsert({
        where: { matchId: m.id },
        update: { content, source, updatedByUserId: context.user.id },
        create: { matchId: m.id, groupId, content, source, updatedByUserId: context.user.id },
      });
      // M9.1 — Save writes ONLY the working copy (content): the published recap
      // (publishedContent) stays player-visible until the organizer publishes again.
      return NextResponse.json({ ok: true, source, published: Boolean(m.recap?.publishedAt), changesUnpublished: Boolean(m.recap?.publishedAt) && content !== m.recap?.publishedContent });
    }
    case "publish_recap": {
      if (!m.recap?.content) return fail("Save the recap first.");
      // M9.1 — publishing copies the saved working copy to the player-visible copy.
      // Idempotent (same text → same state); sends nothing.
      await prisma.matchRecap.update({
        where: { matchId: m.id },
        data: { publishedContent: m.recap.content, publishedAt: m.recap.publishedAt ?? new Date(), publishedByUserId: context.user.id },
      });
      return NextResponse.json({ ok: true });
    }

    // ---------------- explicit Telegram posts
    case "post_message": {
      const destination = await matchDestination(groupId, m.telegramChatId);
      if (!destination) return fail("Choose a connected Telegram group for this match first.");
      const view = await resolveViewUrl(context, body.shareUrl, m.id);
      if (!view.ok) return view.response;
      const content = summaryMessage(m, view.url, context.activeGroup.sportKey);
      if (typeof content === "string") return fail(content);
      const decision = await reserveDelivery(context, m.id, "MATCH_SUMMARY_POSTED", destination, content.contentHash, body.intent, content.acceptedHashes);
      if (decision.kind === "respond") return decision.response;
      const sent = await sendReserved(decision.deliveryId, () =>
        callTelegram("sendMessage", { chat_id: destination, text: content.html, parse_mode: "HTML", disable_web_page_preview: true })
      );
      if (!sent.ok) return sent.response;
      await prisma.messageDelivery.update({ where: { id: decision.deliveryId }, data: { status: "SENT", sentAt: new Date(), providerMessageId: String(sent.sent.message_id) } });
      return NextResponse.json({ ok: true, state: "posted" });
    }
  }
}

// ------------------------------------------------------------------ organizer view

/** Organizer workspace view (ids for organizers only; aggregate MVP counts, never who voted for whom). */
export async function postGameView(context: TenantContext, matchId: string) {
  const m = await loadMatch(context, matchId);
  if (!m) return null;
  const groupId = context.activeGroup.id;
  const manager = isManager(context);
  const participants = participantsOf(m.generation?.teamsJson);
  const participantIds = new Set(participants.map((p) => p.playerId));
  const nameOf = new Map(participants.map((p) => [p.playerId, p.name]));
  const facts = recapFactsOf(m, context.activeGroup.sportKey);

  const voteLocked = await playerVoteLocked(groupId, m.id, m.mvp);
  const method = effectiveMvpMethod(m.mvp, voteLocked);
  let mvp = null;
  if (m.mvp) {
    const tally = await tallyMvp(groupId, m.id, m.mvp.candidatePlayerIds, participantIds);
    const polls = await prisma.telegramPoll.findMany({ where: { matchId: m.id, groupId, kind: "MVP" }, select: { pollId: true } });
    const answered = polls.length ? await prisma.telegramPollAnswer.count({ where: { groupId, pollId: { in: polls.map((p) => p.pollId) }, NOT: { optionIdsJson: "[]" } } }) : 0;
    mvp = {
      started: m.mvp.openedAt !== null,
      open: m.mvp.openedAt !== null && m.mvp.closedAt === null,
      closed: m.mvp.closedAt !== null,
      candidates: tally.counts.map((c) => ({ playerId: c.playerId, name: nameOf.get(c.playerId) ?? "Player", votes: c.votes })),
      eligibleVoters: participants.length,
      validVotes: tally.valid,
      answersNotCounted: Math.max(0, answered - tally.valid),
      leaders: tally.leaders,
      published: m.mvp.publishedAt !== null,
      winners: m.mvp.winnerPlayerIds.map((id) => nameOf.get(id) ?? "Player"),
      decision: m.mvp.decision,
      method,
      voteLocked,
      selection:
        method === "ORGANIZER_SELECTION" && m.mvp.selectedPlayerId
          ? { playerId: m.mvp.selectedPlayerId, name: nameOf.get(m.mvp.selectedPlayerId) ?? "Player", teamNumber: participants.find((p) => p.playerId === m.mvp!.selectedPlayerId)?.teamNumber ?? null }
          : null,
    };
  }

  const destination = manager ? await matchDestination(groupId, m.telegramChatId) : null;
  const summaryHashes = (() => {
    const c = summaryMessage(m, null, context.activeGroup.sportKey);
    return typeof c === "string" ? null : c.acceptedHashes;
  })();
  const messages = manager
    ? {
        destinationConnected: destination !== null,
        summary: await messageState(groupId, m.id, "MATCH_SUMMARY_POSTED", destination, summaryHashes),
        mvpPoll: await messageState(groupId, m.id, "MVP_POLL_POSTED", destination, null),
      }
    : null;

  return {
    canceled: m.status === "CANCELED",
    teamNumbers: teamNumbersOf(participants),
    // M8.1 — the fixtures this match's result consists of (every pair of published teams once).
    fixturePairs: fixturePairs(teamNumbersOf(participants)),
    participants: participants.map((p) => ({ playerId: p.playerId, name: p.name, teamNumber: p.teamNumber })),
    result: m.result ? { ...resultView(parseResult(m.result.scoresJson)), published: m.result.publishedAt !== null, complete: isCompleteFor(parseResult(m.result.scoresJson), teamNumbersOf(participants)) } : null,
    mvp,
    mvpMaxCandidates: MVP_POLL_MAX_OPTIONS,
    // M9.1 — organizers get the saved working copy (and whether it differs from the
    // published one); MEMBER gets ONLY the published recap (never a draft).
    recap: m.recap ? recapView(m.recap, manager) : null,
    standardRecap: facts ? deterministicRecap(facts) : null,
    aiConfigured: aiConfigured(),
    messages,
  };
}

/** Display shape of a result: fixtures (with each fixture's winner) or labeled legacy standings. */
export type ResultView = {
  fixtures: Array<{ teamA: number; teamB: number; scoreA: number; scoreB: number; winner: number | null }>;
  /** Pre-M8.1 rows with one score per team for 3+ teams (never rewritten); null otherwise. */
  legacyStandings: Array<{ teamNumber: number; score: number }> | null;
};

export function resultView(r: MatchResultData | null): ResultView {
  if (!r) return { fixtures: [], legacyStandings: null };
  if (r.kind === "legacy_standings") return { fixtures: [], legacyStandings: r.teams.map((t) => ({ teamNumber: t.teamNumber, score: t.score })) };
  return { fixtures: r.fixtures.map((f) => ({ teamA: f.teamA, teamB: f.teamB, scoreA: f.scoreA, scoreB: f.scoreB, winner: fixtureWinner(f) })), legacyStandings: null };
}

type RecapRow = { content: string | null; publishedContent: string | null; source: string | null; publishedAt: Date | null; generatedContent: string | null };

/**
 * M9.1 — the recap as the Match Workspace sees it. `changesUnpublished`: a
 * published recap whose saved working copy differs (players still see the
 * published copy). Non-managers receive the published copy only.
 */
function recapView(r: RecapRow, manager: boolean) {
  const published = r.publishedAt !== null && r.publishedContent !== null;
  if (!manager) {
    return published ? { content: r.publishedContent, source: null, published: true, changesUnpublished: false, hasAiDraft: false } : null;
  }
  return { content: r.content, source: r.source, published, changesUnpublished: published && r.content !== r.publishedContent, hasAiDraft: r.generatedContent !== null };
}

/** Player-facing published post-game data (allow-list; display names only). */
export function publishedPostGame(m: { result: { scoresJson: string; publishedAt: Date | null } | null; mvp: { winnerPlayerIds: string[]; publishedAt: Date | null } | null; recap: { publishedContent: string | null; publishedAt: Date | null } | null }, teamsJson: string | null) {
  const names = new Map(participantsOf(teamsJson).map((p) => [p.playerId, p.name]));
  // M8.1 — PUBLISHED fixtures only; an unpublished result never appears.
  const parsed = m.result?.publishedAt ? parseResult(m.result.scoresJson) : null;
  return {
    result: parsed ? resultView(parsed) : null,
    mvp: m.mvp?.publishedAt && m.mvp.winnerPlayerIds.length ? { names: m.mvp.winnerPlayerIds.map((id) => names.get(id) ?? "Player"), shared: m.mvp.winnerPlayerIds.length > 1 } : null,
    // M9.1 — the published copy only; the saved working copy is never even loaded for players.
    recap: m.recap?.publishedAt && m.recap.publishedContent ? { text: m.recap.publishedContent } : null,
  };
}

/**
 * Match Summary readiness — the same rules the organizer panel shows, for any
 * server-side caller (e.g. a future agent deciding whether to ASK the
 * organizer to post). Read-only: never publishes or sends.
 */
export async function getMatchSummaryReadiness(
  context: TenantContext,
  matchId: string
): Promise<(SummaryReadiness & { resultPublished: boolean; destinationConnected: boolean; deliveryState: string | null; canPost: boolean }) | null> {
  const view = await postGameView(context, matchId);
  if (!view) return null;
  const manager = isManager(context);
  const readiness = summaryReadiness(view, manager);
  const resultPublished = view.result?.published ?? false;
  const destinationConnected = view.messages?.destinationConnected ?? false;
  const deliveryState = view.messages?.summary ?? null;
  return {
    ...readiness,
    resultPublished,
    destinationConnected,
    deliveryState,
    canPost: manager && !view.canceled && resultPublished && destinationConnected && deliveryState !== "posted" && deliveryState !== "sending",
  };
}
