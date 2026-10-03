import { NextResponse } from "next/server";
import type { MessageEventType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { isManager, managersOnlyResponse } from "@/lib/tenantRoute";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { findSport } from "@/lib/sports";
import { postGameSchema, zodErrorResponse } from "@/lib/validation";
import { contentHashOf, STALE_SENDING_MS } from "@/lib/messaging/deliveryState";
import { renderTelegramHtml, renderTelegramPoll } from "@/lib/messaging/telegram";
import { mvpAnnouncementContent, mvpPollContent, MVP_POLL_MAX_OPTIONS, recapContent, resultContent, type TextContent } from "@/lib/messaging/content";
import { callTelegram, TelegramApiRejectionError } from "@/lib/telegramApi";
import { resolveViewUrl } from "@/lib/telegramCloseAndPost";
import { aiConfigured } from "@/lib/ai/openai";
import { participantsOf } from "@/lib/matchParticipants";
import { applyTelegramMvpAnswer } from "@/lib/telegramMvp";
import { buildRecapFacts, deterministicRecap, generateAiRecap, RECAP_MAX_LENGTH, sanitizeRecapText, type RecapFacts } from "@/lib/recap";

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

type Scores = Array<{ teamNumber: number; score: number }>;
export { participantsOf, applyTelegramMvpAnswer };

export function parseScores(json: string | null | undefined): Scores {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((s) => Number.isInteger(s?.teamNumber) && Number.isInteger(s?.score)).map((s) => ({ teamNumber: s.teamNumber, score: s.score })) : [];
  } catch {
    return [];
  }
}

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

// ------------------------------------------------------------------ deliveries

type Intent = "post" | "post_updated" | "retry_uncertain";
type Reserve = { kind: "send"; deliveryId: string } | { kind: "respond"; response: NextResponse };

/** Same reserve → send → finalize state machine as attendance polls (per Match + event + destination, under a lock). */
async function reserveDelivery(context: TenantContext, matchId: string, event: MessageEventType, destination: string, contentHash: string, intent: Intent): Promise<Reserve> {
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
    if (latest.contentHash === contentHash && intent !== "post_updated") return respond(200, { ok: true, state: "already_posted" });
    if (latest.contentHash !== contentHash && intent !== "post_updated") return respond(409, { error: "This changed since it was posted. Post the update?", state: "updated_available" });
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
async function messageState(groupId: string, matchId: string, event: MessageEventType, destination: string | null, contentHash: string | null) {
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
  if (contentHash && latest.some((d) => d.status === "SENT" && d.contentHash === contentHash)) return "posted";
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
    scores: parseScores(m.result.scoresJson),
    mvpNames: mvpNames(m),
    participantCount: participantsOf(m.generation?.teamsJson).length,
  });
}

function messageContent(m: LoadedMatch, kind: "result" | "mvp" | "recap", viewUrl: string | null): TextContent | string {
  const date = formatYMDFromDate(m.date);
  if (kind === "result") {
    if (!m.result?.publishedAt) return "Publish the result first.";
    return resultContent({ date, scores: parseScores(m.result.scoresJson), viewUrl });
  }
  if (kind === "mvp") {
    const names = mvpNames(m);
    if (names.length === 0) return "Publish the MVP first.";
    return mvpAnnouncementContent({ names, viewUrl });
  }
  if (!m.recap?.publishedAt || !m.recap.content) return "Publish the recap first.";
  return recapContent({ date, text: m.recap.content, viewUrl });
}

const EVENT_OF = { result: "MATCH_RESULT_POSTED", mvp: "MVP_ANNOUNCED", recap: "MATCH_RECAP_POSTED" } as const;
const hashOf = (content: TextContent) => contentHashOf(renderTelegramHtml({ ...content, link: null }));

// ------------------------------------------------------------------ actions

export async function postGameAction(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const parsed = postGameSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const body = parsed.data;
  const groupId = context.activeGroup.id;
  const telegramAction = body.action === "start_mvp" || body.action === "close_mvp" || body.action === "post_message";
  if (telegramAction) {
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
  }
  const m = await loadMatch(context, matchId);
  if (!m) return NOT_FOUND();
  if (m.status === "CANCELED") return fail("This match is canceled. Reopen it before recording post-game details.");
  const participants = participantsOf(m.generation?.teamsJson);
  const participantIds = new Set(participants.map((p) => p.playerId));

  switch (body.action) {
    // ---------------- result
    case "save_result": {
      if (participants.length === 0) return fail("Publish the teams for this match first.");
      const teamNumbers = [...new Set(participants.map((p) => p.teamNumber))].sort((a, b) => a - b);
      const given = [...body.scores].sort((a, b) => a.teamNumber - b.teamNumber);
      if (given.length !== teamNumbers.length || given.some((s, i) => s.teamNumber !== teamNumbers[i])) {
        return fail("Enter one score for each published team.");
      }
      const scoresJson = JSON.stringify(given.map((s) => ({ teamNumber: s.teamNumber, score: s.score })));
      await prisma.matchResult.upsert({
        where: { matchId: m.id },
        update: { scoresJson, updatedByUserId: context.user.id },
        create: { matchId: m.id, groupId, scoresJson, updatedByUserId: context.user.id },
      });
      return NextResponse.json({ ok: true, published: Boolean(m.result?.publishedAt) });
    }
    case "publish_result": {
      if (!m.result) return fail("Save the result first.");
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
      await prisma.matchMvp.upsert({ where: { matchId: m.id }, update: { candidatePlayerIds: candidates }, create: { matchId: m.id, groupId, candidatePlayerIds: candidates } });
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
    case "publish_mvp": {
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
      return NextResponse.json({ ok: true, source, published: Boolean(m.recap?.publishedAt) });
    }
    case "publish_recap": {
      if (!m.recap?.content) return fail("Save the recap first.");
      await prisma.matchRecap.update({ where: { matchId: m.id }, data: { publishedAt: m.recap.publishedAt ?? new Date(), publishedByUserId: context.user.id } });
      return NextResponse.json({ ok: true });
    }

    // ---------------- explicit Telegram posts
    case "post_message": {
      const destination = await matchDestination(groupId, m.telegramChatId);
      if (!destination) return fail("Choose a connected Telegram group for this match first.");
      const view = await resolveViewUrl(context, body.shareUrl, m.id);
      if (!view.ok) return view.response;
      const content = messageContent(m, body.kind, view.url);
      if (typeof content === "string") return fail(content);
      const decision = await reserveDelivery(context, m.id, EVENT_OF[body.kind], destination, hashOf(content), body.intent);
      if (decision.kind === "respond") return decision.response;
      const sent = await sendReserved(decision.deliveryId, () =>
        callTelegram("sendMessage", { chat_id: destination, text: renderTelegramHtml(content), parse_mode: "HTML", disable_web_page_preview: true })
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
    };
  }

  const destination = manager ? await matchDestination(groupId, m.telegramChatId) : null;
  const hash = (kind: "result" | "mvp" | "recap") => {
    const c = messageContent(m, kind, null);
    return typeof c === "string" ? null : hashOf(c);
  };
  const messages = manager
    ? {
        destinationConnected: destination !== null,
        result: await messageState(groupId, m.id, "MATCH_RESULT_POSTED", destination, hash("result")),
        mvp: await messageState(groupId, m.id, "MVP_ANNOUNCED", destination, hash("mvp")),
        recap: await messageState(groupId, m.id, "MATCH_RECAP_POSTED", destination, hash("recap")),
        mvpPoll: await messageState(groupId, m.id, "MVP_POLL_POSTED", destination, null),
      }
    : null;

  return {
    canceled: m.status === "CANCELED",
    teamNumbers: [...new Set(participants.map((p) => p.teamNumber))].sort((a, b) => a - b),
    participants: participants.map((p) => ({ playerId: p.playerId, name: p.name, teamNumber: p.teamNumber })),
    result: m.result ? { scores: parseScores(m.result.scoresJson), published: m.result.publishedAt !== null } : null,
    mvp,
    mvpMaxCandidates: MVP_POLL_MAX_OPTIONS,
    recap: m.recap ? { content: m.recap.content, source: m.recap.source, published: m.recap.publishedAt !== null, hasAiDraft: m.recap.generatedContent !== null } : null,
    standardRecap: facts ? deterministicRecap(facts) : null,
    aiConfigured: aiConfigured(),
    messages,
  };
}

/** Player-facing published post-game data (allow-list; display names only). */
export function publishedPostGame(m: { result: { scoresJson: string; publishedAt: Date | null } | null; mvp: { winnerPlayerIds: string[]; publishedAt: Date | null } | null; recap: { content: string | null; publishedAt: Date | null } | null }, teamsJson: string | null) {
  const names = new Map(participantsOf(teamsJson).map((p) => [p.playerId, p.name]));
  const scores = m.result?.publishedAt ? parseScores(m.result.scoresJson).sort((a, b) => a.teamNumber - b.teamNumber) : null;
  const top = scores?.length ? Math.max(...scores.map((s) => s.score)) : null;
  const leaders = scores?.filter((s) => s.score === top) ?? [];
  return {
    result: scores ? { teams: scores.map((s) => ({ teamNumber: s.teamNumber, score: s.score })), winnerTeamNumber: leaders.length === 1 ? leaders[0].teamNumber : null, draw: leaders.length > 1 } : null,
    mvp: m.mvp?.publishedAt && m.mvp.winnerPlayerIds.length ? { names: m.mvp.winnerPlayerIds.map((id) => names.get(id) ?? "Player"), shared: m.mvp.winnerPlayerIds.length > 1 } : null,
    recap: m.recap?.publishedAt && m.recap.content ? { text: m.recap.content } : null,
  };
}
