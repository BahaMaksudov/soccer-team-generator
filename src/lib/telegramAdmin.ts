import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  resolvePollDisplayDate,
  resolvePollCalendarDate,
  formatYMDFromDate,
  isPlayingVote,
} from "@/lib/telegramFormat";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import {
  telegramCreatePollSchema,
  telegramImportSchema,
  telegramLinkSchema,
  zodErrorResponse,
} from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";
// Phase 2D.6D.5D: moved (unchanged behavior) to a shared module so the
// canonical close-and-post core can classify Telegram rejections.
import { callTelegram } from "@/lib/telegramApi";

/**
 * Phase 2D.6D.5B — shared Telegram READ core, extracted verbatim from
 * the legacy /api/admin/telegram/chats, /polls, and /users route
 * bodies (only the tenant resolution step was removed).
 *
 * Phase 2D.6D.5C — extended with the three MUTATION operations
 * (create-poll, import, link), extracted verbatim from the legacy
 * /api/admin/telegram/create-poll, /import, and /link route bodies
 * (again, only the tenant resolution step was removed — see each
 * function's own comment for any disclosed, non-verbatim addition).
 *
 * The canonical URL-bound routes (requireTenantContextForSlugs())
 * delegate here after resolving and authorizing their TenantContext
 * (the legacy flat routes were deleted in Phase 2D.6D.5E.5) — this
 * module never resolves tenancy itself and never
 * reads request body/query for ownership, only context.activeGroup.id.
 *
 * Closing a poll and posting generated teams is NOT done here: it is
 * the separate canonical Close/Post operation in
 * src/lib/telegramCloseAndPost.ts (Phase 2D.6D.5D). Publish itself is
 * DB-only (src/lib/publishTeams.ts).
 */

export async function listTelegramChatsForContext(context: TenantContext): Promise<NextResponse> {
  const chats = await prisma.telegramChat.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: { updatedAt: "desc" },
    select: { chatId: true, title: true },
  });

  return NextResponse.json({
    chats: chats.map((c) => ({
      chatId: c.chatId.toString(),
      title: c.title ?? "",
    })),
  });
}

export async function listTelegramPollsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  const polls = await prisma.telegramPoll.findMany({
    where: {
      groupId: context.activeGroup.id,
      ...(includeClosed ? {} : { isClosed: false }),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      pollId: true,
      chatId: true,
      question: true,
      pollDate: true,
      isClosed: true,
      createdAt: true,
    },
  });

  const chatIds = Array.from(new Set(polls.map((p) => p.chatId.toString())));

  const chats = await prisma.telegramChat.findMany({
    where: { chatId: { in: chatIds.map((id) => BigInt(id)) } },
    select: { chatId: true, title: true },
  });

  const titleByChatId = new Map<string, string>();
  for (const c of chats) {
    titleByChatId.set(c.chatId.toString(), c.title ?? "");
  }

  const items = polls.map((p) => {
    const chatIdStr = p.chatId.toString();
    return {
      pollId: p.pollId,
      chatId: chatIdStr,
      chatTitle: titleByChatId.get(chatIdStr) || `Chat ${chatIdStr}`,
      question: p.question ?? "",
      isClosed: Boolean(p.isClosed),
      createdAt: p.createdAt ? p.createdAt.toISOString() : null,
      pollDate: resolvePollCalendarDate(p),
      pollDateStr: resolvePollDisplayDate(p, null),
      // Phase 2D.6D.5D (additive field): the persisted TelegramPoll.pollDate
      // column ONLY — null whenever the column is null, never derived
      // from question text. `pollDate` above keeps its question-text
      // fallback for display/import; canonical Close/Post eligibility
      // must use this field instead.
      persistedPollDate: p.pollDate ? formatYMDFromDate(p.pollDate) : null,
    };
  });

  return NextResponse.json({ polls: items });
}

export async function listUnlinkedTelegramUsersForContext(context: TenantContext): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const users = await prisma.telegramPollAnswer.findMany({
    where: { groupId: activeGroupId },
    distinct: ["userId"],
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const linked = await prisma.telegramUserLink.findMany({
    where: { groupId: activeGroupId },
    select: { userId: true },
  });

  const linkedSet = new Set(linked.map((l) => l.userId.toString()));

  const unlinked = users
    .filter((u) => !linkedSet.has(u.userId.toString()))
    .map((u) => ({
      userId: u.userId.toString(),
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
    }));

  return NextResponse.json(unlinked);
}

function formatMdyTwoDigitYear(ymd: string) {
  // ymd = YYYY-MM-DD -> M/D/YY (no leading zeros)
  const [y, m, d] = ymd.split("-").map(Number);
  const yy = String(y).slice(-2);
  return `${m}/${d}/${yy}`;
}

export async function createTelegramPollForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = telegramCreatePollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { chatId: chatIdStr, pollDate: pollDateStr, question: customQuestion } = parsed.data;

  // Ownership validation BEFORE any Telegram side effect — see Phase
  // 2D.3's original fix. 404, not 403: never reveal that a foreign
  // chat exists. Server determines groupId from context only;
  // chatIdStr/pollDateStr/customQuestion come from the schema, which
  // has no groupId/organizationId field.
  let chatIdBigInt: bigint;
  try {
    chatIdBigInt = BigInt(chatIdStr);
  } catch {
    return NextResponse.json({ error: "chatId must be a valid Telegram chat id" }, { status: 400 });
  }

  const chat = await prisma.telegramChat.findFirst({
    where: { chatId: chatIdBigInt, groupId: activeGroupId },
    select: { chatId: true },
  });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  try {
    const pollDate = toDateOnlyUTC(pollDateStr);

    const display = formatMdyTwoDigitYear(pollDateStr);
    const question = customQuestion?.trim() || `Who is playing on ${display}?`;
    const options = ["✅ Playing", "❌ Not playing"];

    // sendPoll returns a Message object (includes message_id and poll.id).
    //
    // Known, pre-existing limitation (Phase 2D.6D.5A §8, unchanged
    // here as instructed): if the process crashes or the network fails
    // between this call succeeding and the upsert below completing, a
    // client retry re-sends a NEW poll to Telegram (sendPoll has no
    // idempotency key). This is identical to the legacy route's
    // existing behavior, not made worse or better by canonicalization.
    const msg = await callTelegram("sendPoll", {
      chat_id: chatIdStr,
      question,
      options,
      is_anonymous: false,
      allows_multiple_answers: false,
    });

    const pollId = msg?.poll?.id;
    const messageId = msg?.message_id;

    if (!pollId || !messageId) {
      return NextResponse.json(
        { error: "Telegram sendPoll succeeded but pollId/messageId missing" },
        { status: 500 }
      );
    }

    await prisma.telegramPoll.upsert({
      where: { pollId: String(pollId) },
      update: {
        chatId: chatIdBigInt,
        messageId: BigInt(messageId),
        question,
        optionsJson: JSON.stringify(options),
        pollDate,
        isClosed: false,
        groupId: activeGroupId,
      },
      create: {
        pollId: String(pollId),
        chatId: chatIdBigInt,
        messageId: BigInt(messageId),
        question,
        optionsJson: JSON.stringify(options),
        pollDate,
        isClosed: false,
        groupId: activeGroupId,
      },
    });

    return NextResponse.json({ ok: true, pollId: String(pollId), messageId });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function importTelegramPollForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = telegramImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { pollId } = parsed.data;

  // The poll being imported must belong to the caller's active Group.
  // 404, not 403 — never reveal that a foreign poll exists.
  const poll = await prisma.telegramPoll.findFirst({
    where: { pollId, groupId: activeGroupId },
    select: { pollId: true },
  });
  if (!poll) {
    return NextResponse.json({ error: "Poll not found" }, { status: 404 });
  }

  // Defense in depth, not just the poll check above.
  const answers = await prisma.telegramPollAnswer.findMany({
    where: { pollId, groupId: activeGroupId },
    select: { userId: true, optionIdsJson: true },
  });

  const playingUserIds = answers
    .filter((a) => isPlayingVote(a.optionIdsJson))
    .map((a) => a.userId);

  if (playingUserIds.length === 0) {
    return NextResponse.json({
      ok: true,
      selectedPlayerIds: [],
      missingUserIds: [],
      note: "No ✅ Playing votes found for that pollId.",
    });
  }

  // Same defense-in-depth principle: only links belonging to the
  // active Group can resolve a Telegram voter to a Player.
  const links = await prisma.telegramUserLink.findMany({
    where: { userId: { in: playingUserIds }, groupId: activeGroupId },
    select: { userId: true, playerId: true },
  });

  const linkMap = new Map(links.map((l) => [l.userId.toString(), l.playerId]));
  const rawSelectedPlayerIds: string[] = [];
  const missingUserIds: string[] = [];

  for (const uid of playingUserIds) {
    const pid = linkMap.get(uid.toString());
    if (pid) rawSelectedPlayerIds.push(pid);
    else missingUserIds.push(uid.toString());
  }

  // Phase 2D.6D.5C disclosed addition (NOT present in the legacy route
  // before this phase): TelegramUserLink.groupId is a denormalized
  // scalar column, not a real FK (see its schema comment) — it is
  // supposed to always match the linked Player's actual groupId,
  // because the link route itself verifies Player.groupId before ever
  // creating a link, and Players are never reassigned between Groups
  // anywhere in this codebase. For all legitimately-linked data this
  // re-check changes nothing: it returns exactly the same
  // selectedPlayerIds. It exists only to stop a stale/corrupted
  // denormalized groupId from ever letting a foreign-Group Player id
  // leave this endpoint. Applied identically to legacy and canonical
  // callers (both delegate to this same function).
  let selectedPlayerIds = rawSelectedPlayerIds;
  if (rawSelectedPlayerIds.length > 0) {
    const validPlayers = await prisma.player.findMany({
      where: { id: { in: rawSelectedPlayerIds }, groupId: activeGroupId },
      select: { id: true },
    });
    const validIds = new Set(validPlayers.map((p) => p.id));
    selectedPlayerIds = rawSelectedPlayerIds.filter((id) => validIds.has(id));
  }

  return NextResponse.json({ ok: true, selectedPlayerIds, missingUserIds });
}

export async function linkTelegramUserForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = telegramLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { userId: userIdStr, playerId: playerIdStr } = parsed.data;

  let userId: bigint;
  try {
    userId = BigInt(userIdStr);
  } catch {
    return NextResponse.json({ error: "userId must be a valid Telegram numeric id" }, { status: 400 });
  }

  // Ownership check: the target Player must belong to the caller's
  // active Group.
  const player = await prisma.player.findFirst({
    where: { id: playerIdStr, groupId: activeGroupId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  // TelegramUserLink.userId is still a single, globally-unique column
  // (Phase 2D.3 §M / Phase 2D.6D.5A §7 — a genuine multi-tenant
  // limitation, not a security hole, and NOT changed in this phase).
  // Because of that this can't be a single atomic tenant-aware upsert
  // — check first whether this Telegram identity is already linked
  // under a DIFFERENT Group, and refuse to silently reassign it.
  const existingLink = await prisma.telegramUserLink.findUnique({ where: { userId } });
  if (existingLink && existingLink.groupId !== activeGroupId) {
    return NextResponse.json(
      { error: "This Telegram user is already linked elsewhere." },
      { status: 409 }
    );
  }

  await prisma.telegramUserLink.upsert({
    where: { userId },
    update: { playerId: playerIdStr, groupId: activeGroupId },
    create: { userId, playerId: playerIdStr, groupId: activeGroupId },
  });

  return NextResponse.json({ ok: true });
}
