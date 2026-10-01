import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { toPlayerFacingTeams, type PlayerFacingTeam } from "@/lib/playerFacing";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import type { GroupVisibility } from "@/lib/publicGroup";

/**
 * M6-A — Group visibility + revocable share links (viewer access, NOT
 * membership).
 *
 * - Token: 32 random bytes (base64url); only its SHA-256 hash is stored.
 *   The raw token is returned once, by createShareLink(), and lives only
 *   in the link the organizer shares.
 * - Link URL: /share#<token>. The token is in the URL FRAGMENT, which
 *   browsers never send to the server or in Referer headers, so it does
 *   not reach request/access logs; the page POSTs it to
 *   /api/share/view.
 * - Rotation: createShareLink() revokes every active link of the Group
 *   and creates a new one (serialized per Group), so at most one link is
 *   live. revokeShareLinks() revokes all. Revoked/unknown/foreign tokens
 *   fail closed with the same "not found".
 * - A share link shows the Group only while its visibility is LINK or
 *   PUBLIC; switching to PRIVATE disables every link without revoking it.
 * - Organizer management is OWNER/ADMIN only; the Group is always the
 *   URL-resolved, membership-verified TenantContext.activeGroup.
 */

export const SHARE_PATH = "/share";
export const shareLinkPath = (token: string) => `${SHARE_PATH}#${token}`;
const SHARE_VIEW_GENERATIONS = 10;
const MANAGERS = ["OWNER", "ADMIN"] as const;

export type ShareSettings = {
  visibility: GroupVisibility;
  activeLink: { createdAt: Date } | null;
};

export async function getShareSettings(context: TenantContext): Promise<ShareSettings> {
  requireRole(context, [...MANAGERS]);
  const [group, link] = await Promise.all([
    prisma.group.findFirst({
      where: { id: context.activeGroup.id, organizationId: context.organization.id },
      select: { visibility: true },
    }),
    prisma.groupShareLink.findFirst({
      where: { groupId: context.activeGroup.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return { visibility: group?.visibility ?? "PRIVATE", activeLink: link };
}

export async function setGroupVisibility(context: TenantContext, visibility: GroupVisibility): Promise<void> {
  requireRole(context, [...MANAGERS]);
  await prisma.group.updateMany({
    where: { id: context.activeGroup.id, organizationId: context.organization.id },
    data: { visibility },
  });
}

/** Rotates: revokes every active link of this Group, then creates one. Returns the raw token ONCE. */
export async function createShareLink(context: TenantContext, now: Date = new Date()): Promise<{ token: string; createdAt: Date }> {
  requireRole(context, [...MANAGERS]);
  const groupId = context.activeGroup.id;
  const token = generateToken();
  const link = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"share-link:" + groupId}))`;
    await tx.groupShareLink.updateMany({ where: { groupId, revokedAt: null }, data: { revokedAt: now } });
    return tx.groupShareLink.create({
      data: { groupId, tokenHash: hashToken(token), createdByUserId: context.user.id },
      select: { createdAt: true },
    });
  });
  return { token, createdAt: link.createdAt };
}

export async function revokeShareLinks(context: TenantContext, now: Date = new Date()): Promise<number> {
  requireRole(context, [...MANAGERS]);
  const { count } = await prisma.groupShareLink.updateMany({
    where: { groupId: context.activeGroup.id, revokedAt: null },
    data: { revokedAt: now },
  });
  return count;
}

export type ShareView = {
  groupName: string;
  teamName: string;
  generations: Array<{ date: string; teams: PlayerFacingTeam[] }>;
};

/** Player-facing data for a share token, or null (unknown/revoked/PRIVATE/inactive — indistinguishable). */
export async function resolveShareView(token: unknown): Promise<ShareView | null> {
  if (!isWellFormedToken(token)) return null;
  const link = await prisma.groupShareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { revokedAt: true, groupId: true },
  });
  if (!link || link.revokedAt) return null;

  const group = await prisma.group.findUnique({
    where: { id: link.groupId },
    select: { id: true, name: true, isActive: true, visibility: true },
  });
  if (!group || !group.isActive || (group.visibility !== "LINK" && group.visibility !== "PUBLIC")) return null;

  const [teamName, rows] = await Promise.all([
    prisma.groupSetting.findUnique({ where: { groupId_key: { groupId: group.id, key: "teamName" } }, select: { value: true } }),
    prisma.teamGeneration.findMany({
      where: { groupId: group.id },
      orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
      take: SHARE_VIEW_GENERATIONS,
      select: { date: true, teamsJson: true },
    }),
  ]);

  return {
    groupName: group.name,
    teamName: teamName?.value?.trim() || "",
    generations: rows.map((r) => ({ date: formatYMDFromDate(r.date), teams: toPlayerFacingTeams(r.teamsJson) })),
  };
}
