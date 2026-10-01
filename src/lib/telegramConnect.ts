import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/secureToken";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * M6-C — secure Telegram self-linking for CLAIMED Players.
 *
 * The signed-in, verified User who has claimed a Player creates a short
 * code and sends `/connect CODE` (or opens the t.me deep link, which sends
 * `/start CODE`) to the bot. The bot knows WHO (Telegram user id); the
 * code proves WHICH Player/Group. Result: a Group-scoped TelegramUserLink.
 *
 * Code: 16 random bytes base64url (22 chars, 128-bit), SHA-256 stored,
 * 15-minute expiry, single-use, a new code replaces older unused ones.
 * Never `/connect <playerId>`, email or anything predictable.
 *
 * This coexists with organizer-driven linking (Telegram section of the
 * Admin workspace) and never implies Telegram identity == User account.
 */

export const CONNECT_TTL_MS = 15 * 60 * 1000;
const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function generateConnectCode(): string {
  return randomBytes(16).toString("base64url");
}

export function isWellFormedConnectCode(code: unknown): code is string {
  return typeof code === "string" && CODE_PATTERN.test(code);
}

/** Bot username for the t.me deep link, if configured (TELEGRAM_BOT_USERNAME, without @). */
function deepLink(code: string): string | null {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return bot && /^[A-Za-z0-9_]{5,32}$/.test(bot) ? `https://t.me/${bot}?start=${code}` : null;
}

export type CreateConnectCodeResult =
  | { ok: true; code: string; command: string; deepLink: string | null; expiresAt: Date }
  | { ok: false; code: "PLAYER_NOT_FOUND" };

/** Only for a Player the given (verified, session) User has claimed. */
export async function createTelegramConnectCode(userId: string, playerId: string, now: Date = new Date()): Promise<CreateConnectCodeResult> {
  const player = await prisma.player.findFirst({ where: { id: playerId, userId }, select: { id: true, groupId: true } });
  if (!player) return { ok: false, code: "PLAYER_NOT_FOUND" };
  const code = generateConnectCode();
  const expiresAt = new Date(now.getTime() + CONNECT_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"telegram-connect:" + player.id}))`;
    await tx.telegramConnectCode.deleteMany({ where: { playerId: player.id, usedAt: null } });
    await tx.telegramConnectCode.create({
      data: { playerId: player.id, groupId: player.groupId, codeHash: hashToken(code), expiresAt, createdByUserId: userId },
    });
  });
  return { ok: true, code, command: `/connect ${code}`, deepLink: deepLink(code), expiresAt };
}

export type RedeemConnectResult =
  | { ok: true; playerName: string; groupName: string; alreadyLinked: boolean }
  | { ok: false; code: "INVALID" | "TELEGRAM_LINKED_TO_OTHER_PLAYER" };

/** Webhook side: the Telegram user who sent the code is linked to the code's Player. */
export async function redeemTelegramConnectCode(params: { code: unknown; telegramUserId: bigint }, now: Date = new Date()): Promise<RedeemConnectResult> {
  if (!isWellFormedConnectCode(params.code)) return { ok: false, code: "INVALID" };
  const codeHash = hashToken(params.code);
  const found = await prisma.telegramConnectCode.findUnique({ where: { codeHash }, select: { playerId: true } });
  if (!found) return { ok: false, code: "INVALID" };

  return prisma.$transaction(async (tx): Promise<RedeemConnectResult> => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"telegram-connect:" + found.playerId}))`;
    const row = await tx.telegramConnectCode.findUnique({
      where: { codeHash },
      select: { id: true, playerId: true, groupId: true, expiresAt: true, usedAt: true },
    });
    if (!row || row.usedAt || row.expiresAt <= now) return { ok: false, code: "INVALID" };
    const player = await tx.player.findFirst({
      where: { id: row.playerId, groupId: row.groupId },
      select: { firstName: true, lastName: true, group: { select: { name: true } } },
    });
    if (!player) return { ok: false, code: "INVALID" };

    const inGroup = await tx.telegramUserLink.findUnique({
      where: { groupId_userId: { groupId: row.groupId, userId: params.telegramUserId } },
      select: { playerId: true },
    });
    if (inGroup && inGroup.playerId !== row.playerId) return { ok: false, code: "TELEGRAM_LINKED_TO_OTHER_PLAYER" };

    const { count } = await tx.telegramConnectCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now, usedByTelegramUserId: params.telegramUserId },
    });
    if (count !== 1) return { ok: false, code: "INVALID" };

    if (!inGroup) {
      // The Player's own (claimed) account asked for this: it replaces any
      // previous Telegram identity of this Player.
      await tx.telegramUserLink.upsert({
        where: { playerId: row.playerId },
        update: { userId: params.telegramUserId, groupId: row.groupId },
        create: { userId: params.telegramUserId, playerId: row.playerId, groupId: row.groupId },
      });
    }
    return { ok: true, playerName: playerDisplayName(player), groupName: player.group.name, alreadyLinked: Boolean(inGroup) };
  });
}
