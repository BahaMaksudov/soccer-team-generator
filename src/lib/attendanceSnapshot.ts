import { prisma } from "@/lib/prisma";
import { countAttendance, defaultSelection, type AttendanceCounts, type AttendanceRow } from "@/lib/attendance";
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

/** Any Prisma client — the global one, or an interactive transaction's (so a caller inside a transaction never needs a second pooled connection). */
type Db = Pick<typeof prisma, "match" | "community" | "communityPlayer" | "player">;

export async function eligibleRosterIds(groupId: string, communityId: string | null, db: Db = prisma): Promise<{ ids: string[]; communityName: string | null }> {
  const community = communityId ? await db.community.findFirst({ where: { id: communityId, groupId }, select: { id: true, name: true } }) : null;
  if (community) {
    const rows = await db.communityPlayer.findMany({ where: { groupId, communityId: community.id, player: { isActive: true, groupId } }, select: { playerId: true } });
    return { ids: rows.map((r) => r.playerId), communityName: community.name };
  }
  const players = await db.player.findMany({ where: { groupId, isActive: true }, select: { id: true } });
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

/**
 * The Match's CONFIRMED attendees — the authoritative rule behind Generate-from-Match's default
 * selection (attendance.defaultSelection): ACTIVE members of the Match's eligible roster whose
 * EFFECTIVE status is PLAYING (organizer override ?? their own latest answer — web, personal link
 * or a linked Telegram vote). MAYBE, NOT_PLAYING, no answer, inactive players and players outside
 * the roster are never confirmed. Each player once (stable Player ids). null = no such Match here.
 * Used by Reuse previous teams and the Random Player Spotlight.
 */
export async function confirmedAttendeeIds(groupId: string, matchId: string, db: Db = prisma): Promise<string[] | null> {
  const m = await db.match.findFirst({
    where: { id: matchId, groupId },
    select: {
      communityId: true,
      attendanceClosedAt: true,
      attendanceDeadlineAt: true,
      attendance: { select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } },
    },
  });
  if (!m) return null;
  const { ids } = await eligibleRosterIds(groupId, m.communityId, db);
  const eligible = [...new Set(ids)].map((id) => ({ id, isActive: true }));
  return defaultSelection(eligible, m.attendance as AttendanceRow[], effectiveClosedAt(m));
}
