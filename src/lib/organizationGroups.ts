import type { GroupVisibility } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { OrganizationContext } from "@/lib/tenantContext";
import { isManager } from "@/lib/tenantRoute";
import { findSport } from "@/lib/sports";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { adminGroupPath, adminMatchesPath, canonicalAdminMatchPath } from "@/lib/matchPaths";

/**
 * UI-5 — READ-ONLY organizer read model for the Organization's Groups page.
 * Scoped by the URL-resolved, membership-verified OrganizationContext (the
 * caller passes it); a fixed set of queries (no per-Group loop): the active
 * Groups, active-player counts, upcoming Matches, and — for OWNER/ADMIN only —
 * which Groups have a connected Telegram chat. No ratings, stamina or
 * Telegram identities. Nothing is written or cached.
 */
export const VISIBILITY_LABELS: Record<GroupVisibility, string> = { PRIVATE: "Private", LINK: "Anyone with the link", PUBLIC: "Public" };

export type OrganizationGroupCard = {
  slug: string;
  name: string;
  sportKey: string;
  sportLabel: string;
  visibility: GroupVisibility;
  visibilityLabel: string;
  activePlayers: number;
  upcomingMatches: number;
  nextMatch: { date: string; startTime: string | null; href: string } | null;
  /** OWNER/ADMIN only; null when not visible to this role. */
  telegramConnected: boolean | null;
  href: string;
  matchesHref: string;
  playersHref: string;
};

export async function loadOrganizationGroups(context: OrganizationContext, now: Date = new Date()): Promise<{ canManage: boolean; groups: OrganizationGroupCard[] }> {
  const manager = isManager(context);
  const groups = await prisma.group.findMany({
    where: { organizationId: context.organization.id, isActive: true },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: { id: true, name: true, slug: true, sportKey: true, visibility: true },
  });
  const ids = groups.map((g) => g.id);
  const today = toDateOnlyUTC(now.toISOString().slice(0, 10));
  const [players, upcoming, chats] = await Promise.all([
    prisma.player.groupBy({ by: ["groupId"], where: { groupId: { in: ids }, isActive: true }, _count: { _all: true } }),
    prisma.match.findMany({
      where: { groupId: { in: ids }, status: "SCHEDULED", date: { gte: today } },
      orderBy: [{ date: "asc" }, { startTime: "asc" }, { createdAt: "asc" }],
      select: { id: true, groupId: true, date: true, startTime: true },
    }),
    manager
      ? prisma.telegramChat.groupBy({ by: ["groupId"], where: { groupId: { in: ids }, disconnectedAt: null }, _count: { _all: true } })
      : Promise.resolve([] as Array<{ groupId: string; _count: { _all: number } }>),
  ]);
  const playerCount = new Map(players.map((p) => [p.groupId, p._count._all]));
  const chatCount = new Map(chats.map((c) => [c.groupId, c._count._all]));
  const org = context.organization.slug;

  return {
    canManage: manager,
    groups: groups.map((g) => {
      const mine = upcoming.filter((m) => m.groupId === g.id);
      const next = mine[0];
      return {
        slug: g.slug,
        name: g.name,
        sportKey: g.sportKey,
        sportLabel: findSport(g.sportKey)?.label ?? g.sportKey,
        visibility: g.visibility,
        visibilityLabel: VISIBILITY_LABELS[g.visibility],
        activePlayers: playerCount.get(g.id) ?? 0,
        upcomingMatches: mine.length,
        nextMatch: next ? { date: formatYMDFromDate(next.date), startTime: next.startTime, href: canonicalAdminMatchPath(org, g.slug, next.id) } : null,
        telegramConnected: manager ? (chatCount.get(g.id) ?? 0) > 0 : null,
        href: adminGroupPath(org, g.slug),
        matchesHref: adminMatchesPath(org, g.slug),
        playersHref: `${adminGroupPath(org, g.slug)}/players`,
      };
    }),
  };
}
