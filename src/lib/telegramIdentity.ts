import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";

/**
 * M6.1 — removing a Player's Telegram identity link.
 *
 * Two entry points, one rule: only the TelegramUserLink of ONE Player in
 * ONE Group is ever deleted, addressed by (playerId, groupId) after the
 * caller's right to that Player was verified server-side. Never by
 * Telegram user id: the same Telegram identity may be linked to a Player
 * in another Group (M6-C), and that link must stay untouched.
 *
 * Deletes nothing else that matters: the Player, its claimed account
 * (Player.userId), TeamGenerations, polls, poll answers and
 * MessageDelivery rows stay. Poll answers keep their Telegram user id, so
 * history is unchanged; a future import in this Group simply reports the
 * voter as unlinked until someone links them again. Unused /connect codes
 * for the Player are dropped so a code issued before the removal cannot
 * silently re-link it. No Telegram API call.
 *
 * Serialized with /connect code creation and redemption (same advisory
 * lock), and idempotent: removing an absent link is "not_linked".
 */

export type RemoveTelegramLinkResult = "removed" | "not_linked" | "not_found";

const lockPlayerTelegram = (tx: Prisma.TransactionClient, playerId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"telegram-connect:" + playerId}))`;

async function removeLinkInTx(tx: Prisma.TransactionClient, playerId: string, groupId: string): Promise<RemoveTelegramLinkResult> {
  await tx.telegramConnectCode.deleteMany({ where: { playerId, groupId, usedAt: null } });
  const { count } = await tx.telegramUserLink.deleteMany({ where: { playerId, groupId } });
  return count > 0 ? "removed" : "not_linked";
}

/** OWNER/ADMIN of the URL-resolved Group: remove a Player's Telegram link in that Group. */
export async function removePlayerTelegramLink(context: TenantContext, playerId: string): Promise<RemoveTelegramLinkResult> {
  requireRole(context, ["OWNER", "ADMIN"]);
  const groupId = context.activeGroup.id;
  return prisma.$transaction(async (tx) => {
    await lockPlayerTelegram(tx, playerId);
    const player = await tx.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } });
    if (!player) return "not_found";
    return removeLinkInTx(tx, player.id, groupId);
  });
}

/** A signed-in User disconnects Telegram from a Player THEY currently claim (Group taken from that Player). */
export async function disconnectOwnTelegram(userId: string, playerId: string): Promise<RemoveTelegramLinkResult> {
  return prisma.$transaction(async (tx) => {
    await lockPlayerTelegram(tx, playerId);
    const player = await tx.player.findFirst({ where: { id: playerId, userId }, select: { id: true, groupId: true } });
    if (!player) return "not_found";
    return removeLinkInTx(tx, player.id, player.groupId);
  });
}
