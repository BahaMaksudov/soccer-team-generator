import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * M6-C — optional Player ↔ User claiming.
 *
 *   Player  = Group-owned sports identity (never requires a User)
 *   User    = optional Team Balance Pro account
 *   Telegram identity = separate (TelegramUserLink), never implied by a claim
 *
 * An OWNER/ADMIN creates a claim link for one EXISTING Player; whoever
 * holds it can, signed in with a VERIFIED email, explicitly confirm the
 * claim, which sets Player.userId. Nothing is ever matched by name/email/
 * Telegram data. Claiming changes only Player.userId (no history, polls,
 * answers, Telegram links or snapshots are touched).
 *
 * Token: 32 random bytes (base64url), SHA-256 stored, shown once, in the
 * URL fragment (/claim#<token>) so it never reaches request logs; GET
 * never consumes it (preview is read-only; acceptance is an explicit
 * POST). Single-use, 7-day expiry, a new link revokes the previous one.
 * Every create/accept and claim-scoped unlink is serialized per Player.
 *
 * A claim grants only player-facing access to that Group (see
 * src/lib/groupAccess.ts) — never organizer access, which remains
 * OrganizationMembership only.
 */

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CLAIM_PATH = "/claim";
export const claimLinkPath = (token: string) => `${CLAIM_PATH}#${token}`;
const MANAGERS = ["OWNER", "ADMIN"] as const;

const lockPlayer = (tx: Prisma.TransactionClient, playerId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"player-claim:" + playerId}))`;

export type CreateClaimResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; code: "PLAYER_NOT_FOUND" | "ALREADY_CLAIMED" };

/** OWNER/ADMIN: (re)issue the claim link for an unclaimed Player of the active Group. */
export async function createPlayerClaim(context: TenantContext, playerId: string, now: Date = new Date()): Promise<CreateClaimResult> {
  requireRole(context, [...MANAGERS]);
  const activeGroupId = context.activeGroup.id;
  const token = generateToken();
  return prisma.$transaction(async (tx): Promise<CreateClaimResult> => {
    await lockPlayer(tx, playerId);
    const player = await tx.player.findFirst({ where: { id: playerId, groupId: activeGroupId }, select: { userId: true } });
    if (!player) return { ok: false, code: "PLAYER_NOT_FOUND" };
    if (player.userId) return { ok: false, code: "ALREADY_CLAIMED" };
    await tx.playerClaim.updateMany({
      where: { playerId, groupId: activeGroupId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
    await tx.playerClaim.create({
      data: { playerId, groupId: activeGroupId, tokenHash: hashToken(token), expiresAt, createdByUserId: context.user.id },
    });
    return { ok: true, token, expiresAt };
  });
}

/** OWNER/ADMIN: revoke the Player's outstanding claim link(s). Returns how many. */
export async function revokePlayerClaims(context: TenantContext, playerId: string, now: Date = new Date()): Promise<number | null> {
  requireRole(context, [...MANAGERS]);
  const activeGroupId = context.activeGroup.id;
  const player = await prisma.player.findFirst({ where: { id: playerId, groupId: activeGroupId }, select: { id: true } });
  if (!player) return null;
  const { count } = await prisma.playerClaim.updateMany({
    where: { playerId, groupId: activeGroupId, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  return count;
}

/**
 * OWNER/ADMIN: detach the account from a Player (wrong person claimed it).
 * Deletes nothing: the User, the Player, its history and its Telegram link
 * stay. Recorded on the accepted claim row (unlinkedAt / unlinkedByUserId).
 */
export async function unlinkPlayerAccount(context: TenantContext, playerId: string, now: Date = new Date()): Promise<"ok" | "not_found" | "not_claimed"> {
  requireRole(context, [...MANAGERS]);
  const activeGroupId = context.activeGroup.id;
  return prisma.$transaction(async (tx) => {
    await lockPlayer(tx, playerId);
    const player = await tx.player.findFirst({ where: { id: playerId, groupId: activeGroupId }, select: { userId: true } });
    if (!player) return "not_found" as const;
    if (!player.userId) return "not_claimed" as const;
    await tx.player.updateMany({ where: { id: playerId, groupId: activeGroupId }, data: { userId: null } });
    const accepted = await tx.playerClaim.findFirst({
      where: { playerId, groupId: activeGroupId, acceptedByUserId: player.userId, unlinkedAt: null, usedAt: { not: null } },
      orderBy: { usedAt: "desc" },
      select: { id: true },
    });
    if (accepted) {
      await tx.playerClaim.update({ where: { id: accepted.id }, data: { unlinkedAt: now, unlinkedByUserId: context.user.id } });
    }
    return "ok" as const;
  });
}

/** Organizer list flags (no account data): claimed? pending claim link? */
export async function playerAccountFlags(groupId: string, now: Date = new Date()): Promise<Map<string, { claimPending: boolean }>> {
  const pending = await prisma.playerClaim.findMany({
    where: { groupId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { playerId: true },
  });
  return new Map(pending.map((c) => [c.playerId, { claimPending: true }]));
}

export type ClaimPreview =
  | { status: "valid"; organizationName: string; groupName: string; sportKey: string; playerName: string }
  | { status: "expired" | "used" | "invalid" | "already_claimed" };

/** Read-only view for the /claim page. Never consumes anything. */
export async function getClaimPreview(token: unknown, now: Date = new Date()): Promise<ClaimPreview> {
  if (!isWellFormedToken(token)) return { status: "invalid" };
  const claim = await prisma.playerClaim.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
      player: { select: { firstName: true, lastName: true, userId: true, groupId: true } },
      group: { select: { id: true, name: true, sportKey: true, isActive: true, organization: { select: { name: true } } } },
    },
  });
  if (!claim || claim.revokedAt || !claim.group.isActive || claim.player.groupId !== claim.group.id) return { status: "invalid" };
  if (claim.usedAt) return { status: "used" };
  if (claim.expiresAt <= now) return { status: "expired" };
  if (claim.player.userId) return { status: "already_claimed" };
  return {
    status: "valid",
    organizationName: claim.group.organization.name,
    groupName: claim.group.name,
    sportKey: claim.group.sportKey,
    playerName: playerDisplayName(claim.player),
  };
}

export type AcceptClaimResult =
  | { ok: true; alreadyClaimed: boolean; groupId: string }
  | { ok: false; code: "CLAIM_INVALID" | "CLAIM_EXPIRED" | "CLAIM_USED" | "PLAYER_ALREADY_CLAIMED" | "ALREADY_HAS_PLAYER_IN_GROUP" };

/**
 * Accepts a claim for the (session-resolved, email-verified) User.
 * Idempotent for the same User; concurrent/other accepts are refused.
 */
export async function acceptPlayerClaim(userId: string, token: unknown, now: Date = new Date()): Promise<AcceptClaimResult> {
  if (!isWellFormedToken(token)) return { ok: false, code: "CLAIM_INVALID" };
  const tokenHash = hashToken(token);
  const found = await prisma.playerClaim.findUnique({ where: { tokenHash }, select: { playerId: true } });
  if (!found) return { ok: false, code: "CLAIM_INVALID" };

  try {
    return await prisma.$transaction(async (tx): Promise<AcceptClaimResult> => {
      await lockPlayer(tx, found.playerId);
      const claim = await tx.playerClaim.findUnique({
        where: { tokenHash },
        select: { id: true, playerId: true, groupId: true, expiresAt: true, usedAt: true, revokedAt: true, acceptedByUserId: true },
      });
      if (!claim || claim.revokedAt) return { ok: false, code: "CLAIM_INVALID" };
      const player = await tx.player.findFirst({ where: { id: claim.playerId, groupId: claim.groupId }, select: { userId: true } });
      if (!player) return { ok: false, code: "CLAIM_INVALID" };

      if (claim.usedAt) {
        return claim.acceptedByUserId === userId && player.userId === userId
          ? { ok: true, alreadyClaimed: true, groupId: claim.groupId }
          : { ok: false, code: "CLAIM_USED" };
      }
      if (claim.expiresAt <= now) return { ok: false, code: "CLAIM_EXPIRED" };
      if (player.userId && player.userId !== userId) return { ok: false, code: "PLAYER_ALREADY_CLAIMED" };

      if (!player.userId) {
        const other = await tx.player.findFirst({ where: { groupId: claim.groupId, userId }, select: { id: true } });
        if (other) return { ok: false, code: "ALREADY_HAS_PLAYER_IN_GROUP" };
        const { count } = await tx.player.updateMany({
          where: { id: claim.playerId, groupId: claim.groupId, userId: null },
          data: { userId },
        });
        if (count !== 1) return { ok: false, code: "PLAYER_ALREADY_CLAIMED" };
      }
      await tx.playerClaim.update({ where: { id: claim.id }, data: { usedAt: now, acceptedByUserId: userId } });
      // Any other outstanding link for this Player is now pointless.
      await tx.playerClaim.updateMany({
        where: { playerId: claim.playerId, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      return { ok: true, alreadyClaimed: player.userId === userId, groupId: claim.groupId };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, code: "ALREADY_HAS_PLAYER_IN_GROUP" };
    }
    throw e;
  }
}
