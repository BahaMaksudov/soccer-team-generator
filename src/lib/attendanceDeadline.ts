import type { Prisma } from "@prisma/client";
import { addDaysYmd, localHhmm, localYmd, zonedToUtc } from "@/lib/scheduleTime";

/**
 * Phase 4B (step 2) — the ONE attendance-deadline rule, used by every path
 * that accepts, shows or finalizes attendance (Match Link, Telegram answers,
 * My Games, organizer overrides, match views, automation):
 *
 *   attendanceClosedAt set                         → closed (closed by hand or finalized)
 *   attendanceDeadlineAt set and not in the future → closed (enforced at once, before any cron)
 *   otherwise                                      → open
 *
 * attendanceDeadlineAt is the only deadline: MatchAutomation.cutoffDueAt is
 * kept equal to it for recurring Matches (writeAttendanceDeadline) but never
 * closes anything on its own — so a recurring Match reopened after its cutoff
 * (deadline NULL) stays open.
 */
export type DeadlineFields = { attendanceClosedAt: Date | null; attendanceDeadlineAt: Date | null };

export function attendanceIsClosed(m: DeadlineFields, now: Date = new Date()): boolean {
  return m.attendanceClosedAt !== null || (m.attendanceDeadlineAt !== null && m.attendanceDeadlineAt.getTime() <= now.getTime());
}

export function attendanceState(m: DeadlineFields, now: Date = new Date()): "open" | "closed" {
  return attendanceIsClosed(m, now) ? "closed" : "open";
}

/** When attendance closed, for "late answer" rules: the explicit close, else a passed deadline (null while open). */
export function effectiveClosedAt(m: DeadlineFields, now: Date = new Date()): Date | null {
  if (m.attendanceClosedAt) return m.attendanceClosedAt;
  return m.attendanceDeadlineAt && m.attendanceDeadlineAt.getTime() <= now.getTime() ? m.attendanceDeadlineAt : null;
}

/** Organizer input: a local wall-clock date-time in the Group's timezone, "YYYY-MM-DDTHH:MM". */
export const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Local deadline → UTC instant in `tz` (DST-safe). A wall time that does not
 * exist (spring-forward gap) is rejected; a repeated one (fall-back) resolves
 * to the EARLIER instant (zonedToUtc's documented rule).
 */
export function localDeadlineToUtc(local: string, tz: string): { ok: true; at: Date } | { ok: false; error: string } {
  const m = LOCAL_DATETIME.exec(local);
  if (!m) return { ok: false, error: "Use a date and time like 2026-10-19T20:00." };
  const [, ymd, hhmm] = m;
  let at: Date;
  try {
    at = zonedToUtc(ymd, hhmm, tz);
  } catch {
    return { ok: false, error: "Use a date and time like 2026-10-19T20:00." };
  }
  if (localYmd(at, tz) !== ymd || localHhmm(at, tz) !== hhmm) {
    return { ok: false, error: `${hhmm} on ${ymd} doesn't exist in ${tz} (daylight saving change). Choose another time.` };
  }
  return { ok: true, at };
}

/** Kickoff instant of a Match: its date + start time in the Group's timezone; without a start time, the end of the game day. */
export function kickoffAt(date: Date, startTime: string | null, tz: string): Date {
  const ymd = date.toISOString().slice(0, 10);
  return startTime ? zonedToUtc(ymd, startTime, tz) : zonedToUtc(addDaysYmd(ymd, 1), "00:00", tz);
}

export const DEADLINE_IN_PAST = "The attendance deadline must be in the future.";
export const DEADLINE_AFTER_KICKOFF = "The attendance deadline must be before kickoff.";
export const DEADLINE_BEFORE_POLL = "The attendance deadline must be after the attendance poll is sent.";

/** Why a NEW deadline is invalid (null = valid). `pollDueAt`: a recurring Match whose poll hasn't been sent yet. */
export function deadlineError(deadline: Date, kickoff: Date, now: Date, pollDueAt?: Date | null): string | null {
  if (deadline.getTime() <= now.getTime()) return DEADLINE_IN_PAST;
  if (deadline.getTime() >= kickoff.getTime()) return DEADLINE_AFTER_KICKOFF;
  if (pollDueAt && deadline.getTime() <= pollDueAt.getTime()) return DEADLINE_BEFORE_POLL;
  return null;
}

/**
 * Serialize attendance-deadline changes with Match Automation's work on the
 * same Match (the SAME advisory key as matchAutomation's withMatchLock), inside
 * the caller's transaction.
 */
export async function lockMatchAttendance(tx: Prisma.TransactionClient, matchId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"automation:" + matchId}))`;
}

/**
 * The ONLY writer of a Match's deadline after creation: Match.attendanceDeadlineAt
 * and — for a recurring Match — MatchAutomation.cutoffDueAt, in the caller's
 * transaction (atomic). Clearing (null) leaves cutoffDueAt as history; it no
 * longer closes anything (the Match deadline is the only rule).
 */
export async function writeAttendanceDeadline(tx: Prisma.TransactionClient, matchId: string, groupId: string, deadline: Date | null): Promise<void> {
  await tx.match.updateMany({ where: { id: matchId, groupId }, data: { attendanceDeadlineAt: deadline } });
  if (deadline) await tx.matchAutomation.updateMany({ where: { matchId, groupId }, data: { cutoffDueAt: deadline } });
}
