import { prisma } from "@/lib/prisma";
import { effectiveAttendance, type AttendanceRow } from "@/lib/attendance";
import { participantsOf } from "@/lib/matchParticipants";
import { publishedPostGame, type ResultView } from "@/lib/postGame";
import type { FixtureOutcome } from "@/lib/matchResults";
import { findSport } from "@/lib/sports";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { canonicalMatchPath } from "@/lib/matchPaths";

/**
 * UI-6 — "My Games": the signed-in User's PLAYER experience, read-only.
 *
 * Identity: ONLY the Players this User has claimed (Player.userId = User.id)
 * in active Groups — never a membership, a query parameter or client state,
 * and nothing is created. A User may have claimed Players in several
 * Groups/Organizations; each is rendered separately.
 *
 * Player-facing allow-list only: display names, team numbers, dates, the
 * User's own attendance, and PUBLISHED post-game data via the existing
 * publishedPostGame() (result, Player of the Match names, recap). Never
 * ratings, stamina, balance metrics, Telegram identities or other Players'
 * attendance. "Vote open" is informational only — voting happens in the
 * Telegram poll, whose eligibility rules (published participants) are the
 * existing ones (participantsOf).
 */

export type MyTeam = { teamNumber: number; teammates: string[] };

export type MyUpcomingGame = {
  matchId: string;
  date: string;
  startTime: string | null;
  locationName: string | null;
  matchHref: string;
  myStatus: "PLAYING" | "NOT_PLAYING" | "MAYBE" | null;
  myStatusByOrganizer: boolean;
  attendanceClosed: boolean;
  teamsPublished: boolean;
  myTeam: MyTeam | null;
};

export type MyRecentGame = {
  matchId: string;
  date: string;
  startTime: string | null;
  locationName: string | null;
  matchHref: string;
  myTeam: MyTeam;
  /** M8.1 — PUBLISHED fixtures (or labeled pre-M8.1 per-team standings). */
  result: ResultView | null;
  /**
   * My team's own published fixtures, each with its own W/D/L (my team's score
   * first). Never an invented overall result: a 2-team match has one entry; a
   * 3-team match two. Empty without a published fixture result.
   */
  myRecord: Array<{ opponent: number; scoreFor: number; scoreAgainst: number; outcome: FixtureOutcome }>;
  mvp: { names: string[]; shared: boolean } | null;
  recap: { text: string } | null;
  /** The Player-of-the-Match poll is open and this Player is a published participant (existing rule). */
  mvpVoteOpen: boolean;
};

export type MyGamesProfile = {
  playerId: string;
  displayName: string;
  organizationName: string;
  groupName: string;
  sportLabel: string;
  telegramConnected: boolean;
  upcoming: MyUpcomingGame[];
  recent: MyRecentGame[];
};

const UPCOMING = 3;
const RECENT = 5;

const ATTENDANCE_SELECT = { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } as const;

/** My team in a published snapshot: team number + teammates' display names (never ids or ratings). */
function myTeamIn(teamsJson: string | null | undefined, playerId: string): MyTeam | null {
  const participants = participantsOf(teamsJson);
  const me = participants.find((p) => p.playerId === playerId);
  if (!me) return null;
  return { teamNumber: me.teamNumber, teammates: participants.filter((p) => p.teamNumber === me.teamNumber && p.playerId !== playerId).map((p) => p.name) };
}

function recordOf(result: ResultView | null, teamNumber: number): MyRecentGame["myRecord"] {
  return (result?.fixtures ?? [])
    .filter((f) => f.teamA === teamNumber || f.teamB === teamNumber)
    .map((f) => {
      const mine = f.teamA === teamNumber;
      const scoreFor = mine ? f.scoreA : f.scoreB;
      const scoreAgainst = mine ? f.scoreB : f.scoreA;
      return { opponent: mine ? f.teamB : f.teamA, scoreFor, scoreAgainst, outcome: scoreFor > scoreAgainst ? "W" : scoreFor < scoreAgainst ? "L" : "D" };
    });
}

export async function loadMyGames(userId: string, now: Date = new Date()): Promise<MyGamesProfile[]> {
  const today = toDateOnlyUTC(now.toISOString().slice(0, 10));
  const players = await prisma.player.findMany({
    where: { userId, group: { isActive: true } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      telegramLink: { select: { id: true } },
      group: { select: { id: true, name: true, slug: true, sportKey: true, organization: { select: { name: true, slug: true } } } },
    },
  });

  return Promise.all(
    players.map(async (p) => {
      const href = (matchId: string) => canonicalMatchPath(p.group.organization.slug, p.group.slug, matchId);
      const [upcomingRows, pastRows] = await Promise.all([
        prisma.match.findMany({
          where: { groupId: p.group.id, status: "SCHEDULED", date: { gte: today } },
          orderBy: [{ date: "asc" }, { startTime: "asc" }, { createdAt: "asc" }],
          take: UPCOMING,
          select: {
            id: true,
            date: true,
            startTime: true,
            locationName: true,
            attendanceClosedAt: true,
            attendance: { where: { playerId: p.id }, select: ATTENDANCE_SELECT },
            generation: { select: { teamsJson: true } },
          },
        }),
        // Recent = past (or completed) non-canceled Matches with published teams; filtered to ones I played in.
        prisma.match.findMany({
          where: { groupId: p.group.id, status: { not: "CANCELED" }, generation: { isNot: null }, OR: [{ date: { lt: today } }, { status: "COMPLETED" }] },
          orderBy: [{ date: "desc" }, { startTime: "desc" }, { createdAt: "desc" }],
          take: RECENT * 4,
          select: {
            id: true,
            date: true,
            startTime: true,
            locationName: true,
            generation: { select: { teamsJson: true } },
            result: { select: { scoresJson: true, publishedAt: true } },
            mvp: { select: { winnerPlayerIds: true, publishedAt: true, openedAt: true, closedAt: true } },
            recap: { select: { content: true, publishedAt: true } },
          },
        }),
      ]);

      const upcoming: MyUpcomingGame[] = upcomingRows.map((m) => {
        const eff = effectiveAttendance(m.attendance[0] as AttendanceRow | undefined, m.attendanceClosedAt);
        return {
          matchId: m.id,
          date: formatYMDFromDate(m.date),
          startTime: m.startTime,
          locationName: m.locationName,
          matchHref: href(m.id),
          myStatus: eff.status,
          myStatusByOrganizer: eff.overridden,
          attendanceClosed: m.attendanceClosedAt !== null,
          teamsPublished: m.generation !== null,
          myTeam: myTeamIn(m.generation?.teamsJson, p.id),
        };
      });

      const recent: MyRecentGame[] = [];
      for (const m of pastRows) {
        const myTeam = myTeamIn(m.generation?.teamsJson, p.id);
        if (!myTeam) continue;
        const pub = publishedPostGame(m, m.generation?.teamsJson ?? null);
        recent.push({
          matchId: m.id,
          date: formatYMDFromDate(m.date),
          startTime: m.startTime,
          locationName: m.locationName,
          matchHref: href(m.id),
          myTeam,
          result: pub.result,
          myRecord: recordOf(pub.result, myTeam.teamNumber),
          mvp: pub.mvp,
          recap: pub.recap,
          mvpVoteOpen: Boolean(m.mvp?.openedAt && !m.mvp.closedAt && !m.mvp.publishedAt),
        });
        if (recent.length >= RECENT) break;
      }

      return {
        playerId: p.id,
        displayName: `${p.firstName} ${p.lastName}`.trim(),
        organizationName: p.group.organization.name,
        groupName: p.group.name,
        sportLabel: findSport(p.group.sportKey)?.label ?? p.group.sportKey,
        telegramConnected: p.telegramLink.length > 0,
        upcoming,
        recent,
      };
    })
  );
}
