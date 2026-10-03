import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { matchTelegramChatSchema, telegramChatPlayerSchema, zodErrorResponse } from "@/lib/validation";

/**
 * M9-B — Telegram chat ↔ Player DEFAULT scope and the Match's selected chat.
 *
 * Telegram cannot enumerate a group's members, so the scope is curated by
 * OWNER/ADMIN. It is keyed by Player (never a Telegram user id) and is only a
 * default roster view: any Group Player can still be added to a Match, and
 * attendance stays Match + Player (a linked vote counts from any chat).
 *
 * Linked voters seen in a chat's polls are offered as SUGGESTIONS only —
 * nothing is persisted because someone voted. Every id from the browser is
 * resolved against the URL-bound Group (foreign/unknown == 404); the database
 * additionally enforces chat.groupId == player.groupId == row.groupId.
 * Nothing here sends anything.
 */

const notFound = (what: string) => NextResponse.json({ error: `${what} not found` }, { status: 404 });

/** A chat of THIS Group by its opaque ref (TelegramChat.id). Connected only unless `includeDisconnected`. */
async function groupChat(groupId: string, ref: number, includeDisconnected = false) {
  return prisma.telegramChat.findFirst({
    where: { id: ref, groupId, ...(includeDisconnected ? {} : { disconnectedAt: null }) },
    select: { id: true, chatId: true, title: true, disconnectedAt: true },
  });
}

/** Player ids in a chat's scope (any caller of this Group may need them for the default roster). */
export async function scopePlayerIds(groupId: string, telegramChatId: number): Promise<string[]> {
  const rows = await prisma.telegramChatPlayer.findMany({ where: { groupId, telegramChatId }, select: { playerId: true } });
  return rows.map((r) => r.playerId);
}

/**
 * Suggestions: Players LINKED (TelegramUserLink, this Group) to someone who
 * answered a poll posted in this chat, not yet in its scope. Unlinked voters
 * never become Players here. Returns Player ids only — no Telegram identity.
 */
export async function suggestedPlayerIds(groupId: string, chat: { id: number; chatId: bigint }): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ playerId: string }>>(Prisma.sql`
    SELECT DISTINCT l."playerId"
    FROM "TelegramPollAnswer" a
    JOIN "TelegramPoll" p ON p."pollId" = a."pollId" AND p."groupId" = ${groupId} AND p."chatId" = ${chat.chatId}
    JOIN "TelegramUserLink" l ON l."userId" = a."userId" AND l."groupId" = ${groupId}
    JOIN "Player" pl ON pl."id" = l."playerId" AND pl."groupId" = ${groupId}
    WHERE a."groupId" = ${groupId}
      AND NOT EXISTS (
        SELECT 1 FROM "TelegramChatPlayer" s WHERE s."telegramChatId" = ${chat.id} AND s."playerId" = l."playerId"
      )
    ORDER BY l."playerId"`);
  return rows.map((r) => r.playerId);
}

/** OWNER/ADMIN: a chat's scope + suggestions. */
export async function getTelegramChatScope(context: TenantContext, ref: number): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const groupId = context.activeGroup.id;
  const chat = await groupChat(groupId, ref, true);
  if (!chat) return notFound("Telegram group");
  const [playerIds, suggestions] = await Promise.all([scopePlayerIds(groupId, chat.id), suggestedPlayerIds(groupId, chat)]);
  return NextResponse.json({
    chat: { ref: chat.id, title: chat.title || "Telegram group", connected: chat.disconnectedAt === null },
    playerIds,
    suggestedPlayerIds: suggestions,
  });
}

/** OWNER/ADMIN: add (idempotent) or remove one Player of this Group to/from a connected chat's scope. */
export async function changeTelegramChatScope(context: TenantContext, ref: number, req: Request, action: "add" | "remove"): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = telegramChatPlayerSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const chat = await groupChat(groupId, ref, action === "remove");
  if (!chat) return notFound("Telegram group");
  const player = await prisma.player.findFirst({ where: { id: parsed.data.playerId, groupId }, select: { id: true } });
  if (!player) return notFound("Player");

  if (action === "remove") {
    await prisma.telegramChatPlayer.deleteMany({ where: { telegramChatId: chat.id, playerId: player.id, groupId } });
    return NextResponse.json({ ok: true });
  }
  // The label is decided server-side: SUGGESTED_VOTE only if the Player really is a current suggestion.
  const source =
    parsed.data.fromSuggestion && (await suggestedPlayerIds(groupId, chat)).includes(player.id) ? "SUGGESTED_VOTE" : "ORGANIZER";
  try {
    await prisma.telegramChatPlayer.create({
      data: { groupId, telegramChatId: chat.id, playerId: player.id, source, createdByUserId: context.user.id },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; // already in scope → no-op
  }
  return NextResponse.json({ ok: true });
}

/**
 * OWNER/ADMIN: select (or clear with null) the Match's Telegram chat. Context
 * only — it is not evidence of a send, and it changes no attendance or teams.
 */
export async function setMatchTelegramChat(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = matchTelegramChatSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const match = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { id: true } });
  if (!match) return notFound("Match");
  const ref = parsed.data.chatRef;
  if (ref !== null) {
    const chat = await groupChat(groupId, ref);
    if (!chat) return notFound("Telegram group");
  }
  await prisma.match.updateMany({ where: { id: match.id, groupId }, data: { telegramChatId: ref } });
  return NextResponse.json({ ok: true, chatRef: ref });
}
