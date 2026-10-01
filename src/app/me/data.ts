import { prisma } from "@/lib/prisma";
import { playerDisplayName, toPlayerFacingTeams } from "@/lib/playerFacing";
import { formatYMDFromDate } from "@/lib/telegramFormat";

/**
 * M6-C — "My teams" for a signed-in User: every Player they have CLAIMED
 * (Player.userId = User.id), across Groups/sports. Player-facing data
 * only (allow-listed names/teams/dates); never ratings, stamina, Telegram
 * ids, settings or membership data. Not an organizer view.
 */
export type MyPlayer = {
  playerId: string;
  displayName: string;
  organizationName: string;
  groupName: string;
  sportKey: string;
  groupHref: string;
  telegramConnected: boolean;
  recent: Array<{ date: string; teamNumber: number; teammates: string[] }>;
};

const RECENT_GAMES = 5;

/** Which team (by its position in the snapshot) the Player was on, or -1. */
function teamIndexOf(teamsJson: string, playerId: string): number {
  try {
    const teams = JSON.parse(teamsJson);
    if (!Array.isArray(teams)) return -1;
    return teams.findIndex((t) => Array.isArray(t?.players) && t.players.some((p: { id?: unknown }) => p?.id === playerId));
  } catch {
    return -1;
  }
}

export async function loadMyPlayers(userId: string): Promise<MyPlayer[]> {
  const players = await prisma.player.findMany({
    where: { userId, group: { isActive: true } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      telegramLink: { select: { id: true } },
      group: { select: { id: true, name: true, slug: true, sportKey: true, organization: { select: { name: true, slug: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  return Promise.all(
    players.map(async (p) => {
      const gens = await prisma.teamGeneration.findMany({
        where: { groupId: p.group.id },
        orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
        take: RECENT_GAMES * 3,
        select: { date: true, teamsJson: true },
      });
      const recent: MyPlayer["recent"] = [];
      for (const g of gens) {
        const idx = teamIndexOf(g.teamsJson, p.id);
        if (idx < 0) continue;
        const team = toPlayerFacingTeams(g.teamsJson)[idx];
        if (!team) continue;
        recent.push({ date: formatYMDFromDate(g.date), teamNumber: team.teamNumber, teammates: team.players.map(playerDisplayName) });
        if (recent.length >= RECENT_GAMES) break;
      }
      return {
        playerId: p.id,
        displayName: playerDisplayName(p),
        organizationName: p.group.organization.name,
        groupName: p.group.name,
        sportKey: p.group.sportKey,
        groupHref: `/g/${encodeURIComponent(p.group.organization.slug)}/${encodeURIComponent(p.group.slug)}`,
        telegramConnected: p.telegramLink.length > 0,
        recent,
      };
    })
  );
}
