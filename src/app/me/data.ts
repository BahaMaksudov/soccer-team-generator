import { prisma } from "@/lib/prisma";
import { playerDisplayName, toPlayerFacingTeams } from "@/lib/playerFacing";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { effectiveAttendance, type AttendanceRow } from "@/lib/attendance";

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
  /** M9-A — the next scheduled Match of this Group (player-facing fields only). */
  nextMatch: {
    id: string;
    date: string;
    startTime: string | null;
    locationName: string | null;
    myStatus: "PLAYING" | "NOT_PLAYING" | "MAYBE" | null;
    myStatusByOrganizer: boolean;
    /** UI-4B — closed attendance is read-only for the player too. */
    attendanceClosed: boolean;
    myTeam: { teamNumber: number; teammates: string[] } | null;
  } | null;
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
      // M9-A — next scheduled Match (today or later), my effective attendance, my team if published for it.
      const match = await prisma.match.findFirst({
        where: { groupId: p.group.id, status: "SCHEDULED", date: { gte: toDateOnlyUTC(new Date().toISOString().slice(0, 10)) } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          date: true,
          startTime: true,
          locationName: true,
          attendanceClosedAt: true,
          attendance: { where: { playerId: p.id }, select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } },
          generation: { select: { teamsJson: true } },
        },
      });
      let nextMatch: MyPlayer["nextMatch"] = null;
      if (match) {
        const eff = effectiveAttendance(match.attendance[0] as AttendanceRow | undefined, match.attendanceClosedAt);
        let myTeam: { teamNumber: number; teammates: string[] } | null = null;
        if (match.generation) {
          const idx = teamIndexOf(match.generation.teamsJson, p.id);
          const team = idx >= 0 ? toPlayerFacingTeams(match.generation.teamsJson)[idx] : null;
          if (team) myTeam = { teamNumber: team.teamNumber, teammates: team.players.map(playerDisplayName) };
        }
        nextMatch = {
          id: match.id,
          date: formatYMDFromDate(match.date),
          startTime: match.startTime,
          locationName: match.locationName,
          myStatus: eff.status,
          myStatusByOrganizer: eff.overridden,
          attendanceClosed: match.attendanceClosedAt !== null,
          myTeam,
        };
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
        nextMatch,
      };
    })
  );
}
