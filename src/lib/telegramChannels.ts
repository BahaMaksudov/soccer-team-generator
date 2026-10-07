import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { hashToken } from "@/lib/secureToken";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { callTelegram } from "@/lib/telegramApi";

/**
 * M9-A — self-service "Connect Telegram Group" (Communication Channels).
 *
 * Flow (verified against the official Bot API, see the M9-A report):
 *  1. OWNER/ADMIN issues a one-time bind code for THIS Group: "g_" + 128-bit
 *     base64url, 15 minutes, single use, stored only as a SHA-256 hash.
 *  2. They add the bot to their Telegram group via t.me/<bot>?startgroup=<code>
 *     (Telegram then delivers "/start@<bot> <code>" in the group) or type
 *     "/connectgroup@<bot> <code>" there (addressed form, so it reaches a bot in
 *     privacy mode).
 *  3. The webhook redeems it: valid/unused/unexpired code, a group/supergroup,
 *     a real (non-anonymous) sender who is an administrator of that chat
 *     (getChatAdministrators), and a chat not already bound to ANOTHER Group.
 *     The chat is then bound to exactly the code's Group.
 *
 * A valid code alone is never enough (admin check). Chats already bound to
 * another Group are refused without revealing that Group. Raw chat ids are
 * never returned to the UI (chats are referenced by TelegramChat.id).
 *
 * M9-B — soft disconnect: disconnecting (or the bot being removed from the
 * chat) sets TelegramChat.disconnectedAt; the row, its player scope, polls
 * and deliveries are kept. Reconnecting the same chat to the same Group
 * reactivates that row. A chat is ACTIVE in at most one Group (partial
 * unique index); a chat disconnected from Group A may be connected to Group
 * B only with B's own code + Telegram-admin proof, as a NEW row — A's row
 * and history stay with A; nothing ever moves between Groups. Issuing a new
 * code expires the Group's older unused codes.
 */

export const BIND_CODE_PREFIX = "g_";
export const BIND_CODE_TTL_MS = 15 * 60 * 1000;
const BIND_CODE_PATTERN = /^g_[A-Za-z0-9_-]{22}$/;

export function generateBindCode(): string {
  return BIND_CODE_PREFIX + randomBytes(16).toString("base64url");
}

export function isBindCode(code: unknown): code is string {
  return typeof code === "string" && BIND_CODE_PATTERN.test(code);
}

function botUsername(): string | null {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return bot && /^[A-Za-z0-9_]{5,32}$/.test(bot) ? bot : null;
}

/** OWNER/ADMIN: the Group's connected Telegram chats (title only, opaque ref — never the raw chat id). */
export async function listTelegramChannels(context: TenantContext): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const chats = await prisma.telegramChat.findMany({
    where: { groupId: context.activeGroup.id, disconnectedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, createdAt: true },
  });
  return NextResponse.json({
    telegram: chats.map((c) => ({ ref: c.id, title: c.title || "Telegram group", connectedAt: c.createdAt.toISOString() })),
    botConfigured: Boolean(botUsername()),
  });
}

/** OWNER/ADMIN: issue a one-time bind code for this Group (returned once; only its hash is stored). */
export async function issueTelegramBindCode(context: TenantContext, now: Date = new Date()): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const code = generateBindCode();
  const expiresAt = new Date(now.getTime() + BIND_CODE_TTL_MS);
  await prisma.$transaction([
    // M9-B — only the newest code of this Group is redeemable.
    prisma.telegramChatBindCode.updateMany({
      where: { groupId: context.activeGroup.id, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    }),
    prisma.telegramChatBindCode.create({
      data: { groupId: context.activeGroup.id, codeHash: hashToken(code), expiresAt, createdByUserId: context.user.id },
    }),
  ]);
  const bot = botUsername();
  return NextResponse.json(
    {
      ok: true,
      code,
      expiresAt,
      deepLink: bot ? `https://t.me/${bot}?startgroup=${code}` : null,
      command: bot ? `/connectgroup@${bot} ${code}` : `/connectgroup ${code}`,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * OWNER/ADMIN: disconnect one connected chat of this Group (soft). History
 * (polls, answers, deliveries, links, player scope) is kept; a reconnect with
 * a new code reactivates the same row.
 */
export async function disconnectTelegramChannel(context: TenantContext, ref: number, now: Date = new Date()): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const { count } = await prisma.telegramChat.updateMany({
    where: { id: ref, groupId: context.activeGroup.id, disconnectedAt: null },
    data: { disconnectedAt: now },
  });
  if (count !== 1) return NextResponse.json({ error: "Telegram group not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/**
 * Webhook (my_chat_member): the bot was removed from / left a chat → mark the
 * active binding disconnected. Nothing is deleted. Re-adding the bot does NOT
 * reconnect by itself — that still needs an organizer's code.
 */
export async function markTelegramChatBotRemoved(chatId: number | string, status: unknown, now: Date = new Date()): Promise<boolean> {
  if (status !== "left" && status !== "kicked") return false;
  const { count } = await prisma.telegramChat.updateMany({
    where: { chatId: BigInt(chatId), disconnectedAt: null },
    data: { disconnectedAt: now },
  });
  return count > 0;
}

export type BindResult =
  | { ok: true; state: "connected" | "already_connected" | "reconnected"; groupName: string }
  | { ok: false; code: "INVALID" | "NOT_A_GROUP" | "ANONYMOUS_SENDER" | "NOT_ADMIN" | "ALREADY_BOUND_ELSEWHERE" | "ADMIN_CHECK_FAILED" };

type TgChat = { id: number | string; type?: string; title?: string };

/** Webhook: redeem a bind code sent in a Telegram group. */
export async function redeemTelegramBindCode(
  params: { code: unknown; chat: TgChat; fromId: number | string | null | undefined; senderChat?: { id?: number | string } | null },
  now: Date = new Date()
): Promise<BindResult> {
  if (!isBindCode(params.code)) return { ok: false, code: "INVALID" };
  const codeHash = hashToken(params.code);
  const row = await prisma.telegramChatBindCode.findUnique({ where: { codeHash }, select: { id: true, groupId: true, expiresAt: true, usedAt: true } });
  if (!row || row.usedAt || row.expiresAt <= now) return { ok: false, code: "INVALID" };
  if (params.chat.type !== "group" && params.chat.type !== "supergroup") return { ok: false, code: "NOT_A_GROUP" };
  // Anonymous administrators post as the chat itself (sender_chat) with a fake `from`.
  if (params.senderChat || params.fromId === undefined || params.fromId === null) return { ok: false, code: "ANONYMOUS_SENDER" };

  // Admin check before any write. getChatAdministrators (no bot-admin requirement) → ChatMemberOwner/Administrator.
  let admins: Array<{ status?: string; user?: { id?: number | string } }>;
  try {
    admins = await callTelegram("getChatAdministrators", { chat_id: String(params.chat.id) });
  } catch {
    return { ok: false, code: "ADMIN_CHECK_FAILED" };
  }
  const isAdmin = Array.isArray(admins) && admins.some((m) => (m.status === "creator" || m.status === "administrator") && String(m.user?.id) === String(params.fromId));
  if (!isAdmin) return { ok: false, code: "NOT_ADMIN" };

  const chatId = BigInt(params.chat.id);
  const title = (params.chat.title ?? "").slice(0, 200) || null;
  return prisma.$transaction(async (tx): Promise<BindResult> => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"telegram-bind:" + chatId.toString()}))`;
    const code = await tx.telegramChatBindCode.findUnique({ where: { codeHash }, select: { id: true, groupId: true, expiresAt: true, usedAt: true, group: { select: { name: true } } } });
    if (!code || code.usedAt || code.expiresAt <= now) return { ok: false, code: "INVALID" };
    // An ACTIVE binding elsewhere is never taken over (and not revealed).
    const active = await tx.telegramChat.findFirst({ where: { chatId, disconnectedAt: null }, select: { id: true, groupId: true } });
    if (active && active.groupId !== code.groupId) return { ok: false, code: "ALREADY_BOUND_ELSEWHERE" };
    const { count } = await tx.telegramChatBindCode.updateMany({ where: { id: code.id, usedAt: null }, data: { usedAt: now, usedChatTitle: title } });
    if (count !== 1) return { ok: false, code: "INVALID" };
    if (active) {
      await tx.telegramChat.update({ where: { id: active.id }, data: { title } });
      return { ok: true, state: "already_connected", groupName: code.group.name };
    }
    // This Group's own earlier (disconnected) binding → reactivate it, scope and history included.
    const own = await tx.telegramChat.findUnique({ where: { chatId_groupId: { chatId, groupId: code.groupId } }, select: { id: true } });
    if (own) {
      await tx.telegramChat.update({ where: { id: own.id }, data: { title, disconnectedAt: null } });
      return { ok: true, state: "reconnected", groupName: code.group.name };
    }
    // M9.2 — a newly connected chat becomes the channel of a new Community
    // (named after the chat; organizers can rename it or move the chat).
    const community = await tx.community.create({ data: { groupId: code.groupId, name: title || "Telegram group" }, select: { id: true } });
    await tx.telegramChat.create({ data: { chatId, title, groupId: code.groupId, communityId: community.id } });
    return { ok: true, state: "connected", groupName: code.group.name };
  });
}

/** Webhook: a bound group upgraded to a supergroup gets a new chat id — keep the binding (if the new id is free). */
export async function migrateTelegramChat(oldChatId: number | string, newChatId: number | string): Promise<void> {
  const from = BigInt(oldChatId);
  const to = BigInt(newChatId);
  await prisma.$transaction(async (tx) => {
    // Only the ACTIVE binding follows the upgrade (disconnected rows are history).
    const existing = await tx.telegramChat.findFirst({ where: { chatId: from, disconnectedAt: null }, select: { id: true, groupId: true } });
    if (!existing) return;
    const taken = await tx.telegramChat.findFirst({
      where: { chatId: to, OR: [{ disconnectedAt: null }, { groupId: existing.groupId }] },
      select: { id: true },
    });
    if (taken) return;
    await tx.telegramChat.update({ where: { id: existing.id }, data: { chatId: to } });
  });
}

export function bindReplyText(result: BindResult): string {
  if (result.ok) {
    return result.state !== "already_connected"
      ? `✅ This Telegram group is now connected to ${result.groupName} in Team Balance Pro.`
      : `✅ This Telegram group is already connected to ${result.groupName}.`;
  }
  switch (result.code) {
    case "NOT_A_GROUP":
      return "❌ Connect codes work only inside a Telegram group.";
    case "ANONYMOUS_SENDER":
      return "❌ Please send the code as yourself (turn off \"Remain anonymous\" in your admin settings), not anonymously.";
    case "NOT_ADMIN":
      return "❌ Only an administrator of this Telegram group can connect it.";
    case "ALREADY_BOUND_ELSEWHERE":
      return "❌ This Telegram group is already connected to another Team Balance Pro group. Disconnect it there before connecting it here.";
    case "ADMIN_CHECK_FAILED":
      return "❌ Couldn't verify administrators right now. Please try again in a moment.";
    default:
      return "❌ That connect code is invalid or has expired. Create a new one in Team Balance Pro → Communication Channels.";
  }
}
