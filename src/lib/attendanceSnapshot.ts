import { prisma } from "@/lib/prisma";
import { countAttendance, type AttendanceCounts, type AttendanceRow } from "@/lib/attendance";
import { effectiveClosedAt } from "@/lib/attendanceDeadline";

/**
 * THE attendance numbers of a Match — the one calculation behind the Match
 * Workspace counts, both Game Day Update paths (automatic + manual) and the
 * organizers' attendance-ready email.
 *
 * Eligible roster: the ACTIVE members of the Match's Community; a Match without
 * a Community (legacy, or its Community row is gone) uses every ACTIVE Player of
 * the Group. Each eligible player is counted exactly once, by their EFFECTIVE
 * status (organizer override ?? their own latest response — web, match link or
 * linked Telegram vote). Players outside the roster, unlinked Telegram voters
 * and inactive players are never counted. The four counts always add up to
 * rosterSize, and none can be negative.
 */
export type AttendanceSnapshot = { counts: AttendanceCounts; rosterSize: number; eligibleIds: string[]; communityName: string | null; date: Date };

export async function eligibleRosterIds(groupId: string, communityId: string | null): Promise<{ ids: string[]; communityName: string | null }> {
  const community = communityId ? await prisma.community.findFirst({ where: { id: communityId, groupId }, select: { id: true, name: true } }) : null;
  if (community) {
    const rows = await prisma.communityPlayer.findMany({ where: { groupId, communityId: community.id, player: { isActive: true, groupId } }, select: { playerId: true } });
    return { ids: rows.map((r) => r.playerId), communityName: community.name };
  }
  const players = await prisma.player.findMany({ where: { groupId, isActive: true }, select: { id: true } });
  return { ids: players.map((p) => p.id), communityName: null };
}

export async function matchAttendanceSnapshot(groupId: string, matchId: string): Promise<AttendanceSnapshot | null> {
  const m = await prisma.match.findFirst({
    where: { id: matchId, groupId },
    select: {
      date: true,
      communityId: true,
      attendanceClosedAt: true,
      attendanceDeadlineAt: true,
      attendance: { select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } },
    },
  });
  if (!m) return null;
  const { ids, communityName } = await eligibleRosterIds(groupId, m.communityId);
  const unique = [...new Set(ids)];
  return { counts: countAttendance(unique, m.attendance as AttendanceRow[], effectiveClosedAt(m)), rosterSize: unique.length, eligibleIds: unique, communityName, date: m.date };
}
