import type { AttendanceSource, AttendanceStatus, Prisma } from "@prisma/client";

/**
 * M9-A — channel-neutral attendance. Pure precedence rules live here and
 * nowhere else (UI, APIs, the Telegram webhook and explicit sync all call
 * these helpers).
 *
 *   effective = organizer override ?? participant's own latest response
 *
 * Participant responses (web, linked Telegram votes): the latest wins.
 * An organizer override is authoritative until explicitly cleared; a later
 * participant response is still recorded (so clearing the override shows
 * it) but never changes the effective status while the override exists.
 * MAYBE is never "confirmed": Generate-from-Match preselects only PLAYING.
 */

export type AttendanceRow = {
  playerId: string;
  participantStatus: AttendanceStatus | null;
  participantSource: AttendanceSource | null;
  participantRespondedAt: Date | null;
  overrideStatus: AttendanceStatus | null;
  overrideAt: Date | null;
};

export type EffectiveAttendance = {
  status: AttendanceStatus | null;
  /** "OVERRIDE" when the organizer override decides; else the participant's source. */
  source: AttendanceSource | "OVERRIDE" | null;
  overridden: boolean;
  /** The participant answered after attendance was closed. */
  late: boolean;
};

export function effectiveAttendance(row: AttendanceRow | null | undefined, attendanceClosedAt: Date | null): EffectiveAttendance {
  if (!row) return { status: null, source: null, overridden: false, late: false };
  const late = Boolean(attendanceClosedAt && row.participantRespondedAt && row.participantRespondedAt > attendanceClosedAt);
  if (row.overrideStatus) return { status: row.overrideStatus, source: "OVERRIDE", overridden: true, late };
  return { status: row.participantStatus, source: row.participantStatus ? row.participantSource : null, overridden: false, late };
}

export type AttendanceCounts = { PLAYING: number; MAYBE: number; NOT_PLAYING: number; NO_RESPONSE: number };

export function countAttendance(playerIds: string[], rows: AttendanceRow[], attendanceClosedAt: Date | null): AttendanceCounts {
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const counts: AttendanceCounts = { PLAYING: 0, MAYBE: 0, NOT_PLAYING: 0, NO_RESPONSE: 0 };
  for (const id of playerIds) {
    const s = effectiveAttendance(byPlayer.get(id), attendanceClosedAt).status;
    counts[s ?? "NO_RESPONSE"]++;
  }
  return counts;
}

/** Default Generate-from-Match selection: active players whose effective status is PLAYING (never MAYBE). */
export function defaultSelection(players: Array<{ id: string; isActive: boolean }>, rows: AttendanceRow[], attendanceClosedAt: Date | null): string[] {
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  return players.filter((p) => p.isActive && effectiveAttendance(byPlayer.get(p.id), attendanceClosedAt).status === "PLAYING").map((p) => p.id);
}

/**
 * Telegram attendance poll options → status. Match-linked polls use
 * ✅ Playing (0), ❌ Not playing (1), 🤔 Maybe (2); legacy two-option polls
 * share indexes 0 and 1. An empty selection is a retracted vote (null).
 */
export function attendanceFromTelegramOptions(optionIds: unknown): AttendanceStatus | null {
  const ids = Array.isArray(optionIds) ? optionIds : [];
  if (ids.length === 0) return null;
  switch (ids[0]) {
    case 0:
      return "PLAYING";
    case 1:
      return "NOT_PLAYING";
    case 2:
      return "MAYBE";
    default:
      return null;
  }
}

/**
 * Record a participant's own response (latest wins). An older response
 * (e.g. a Telegram answer replayed by explicit sync after a newer web
 * answer) never overwrites a newer one. The organizer override is never
 * touched here. `status: null` records a retraction.
 */
export async function recordParticipantResponse(
  tx: Prisma.TransactionClient,
  input: { matchId: string; groupId: string; playerId: string; status: AttendanceStatus | null; source: AttendanceSource; at: Date }
): Promise<"recorded" | "stale"> {
  const existing = await tx.attendanceResponse.findUnique({
    where: { matchId_playerId: { matchId: input.matchId, playerId: input.playerId } },
    select: { participantRespondedAt: true },
  });
  if (existing?.participantRespondedAt && existing.participantRespondedAt > input.at) return "stale";
  const data = { participantStatus: input.status, participantSource: input.source, participantRespondedAt: input.at };
  await tx.attendanceResponse.upsert({
    where: { matchId_playerId: { matchId: input.matchId, playerId: input.playerId } },
    update: data,
    create: { matchId: input.matchId, groupId: input.groupId, playerId: input.playerId, ...data },
  });
  return "recorded";
}
