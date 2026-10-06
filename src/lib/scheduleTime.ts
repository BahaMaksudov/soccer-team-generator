/**
 * M9.2 — pure, timezone-aware time math for weekly Match schedules.
 *
 * A schedule is expressed in LOCAL wall-clock terms of an IANA timezone
 * (e.g. America/New_York): the game's weekday + time, the poll's "N days
 * before at HH:MM" and the cutoff's "N days before at HH:MM". Every instant
 * is derived from the calendar date + wall time through the platform's IANA
 * database (Intl), so a DST change between two weeks (or between poll and
 * game) never shifts the organizer's wall times. A wall time that does not
 * exist (spring-forward gap) moves forward by the gap; an ambiguous one
 * (fall-back) resolves to the first occurrence. No dependency, no stored
 * offsets.
 */

export type WeeklySchedule = {
  timezone: string;
  /** 0 = Sunday … 6 = Saturday, in the schedule's timezone. */
  weekday: number;
  startTime: string; // HH:MM
  pollDaysBefore: number; // 0–6
  pollTime: string; // HH:MM
  cutoffDaysBefore: number; // 0–6
  cutoffTime: string; // HH:MM
};

export type Occurrence = { gameDate: string; gameAt: Date; pollAt: Date; cutoffAt: Date };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock fields of an instant in `tz`. */
function wall(utcMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (local − UTC, in ms) of `tz` at the instant `utcMs`. */
function offsetMs(utcMs: number, tz: string): number {
  const w = wall(utcMs, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of local `ymd` + `hhmm` in `tz` (DST-safe; see module doc). */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
  if (!YMD.test(ymd) || !HHMM.test(hhmm)) throw new Error("Invalid date or time.");
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const H12 = 12 * 3600_000;
  // The zone's offsets on either side of any transition near this wall time.
  const offsets = [...new Set([offsetMs(local - H12, tz), offsetMs(local, tz), offsetMs(local + H12, tz)])];
  const exact = offsets
    .map((o) => local - o)
    .filter((c) => {
      const w = wall(c, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    });
  // Ambiguous (fall-back): the earlier instant. Nonexistent (spring-forward gap):
  // use the offset in force before the transition — the wall time moves forward by the gap.
  return new Date(exact.length ? Math.min(...exact) : local - offsetMs(local - H12, tz));
}

/** YYYY-MM-DD of an instant in `tz`. */
export function localYmd(at: Date, tz: string): string {
  const w = wall(at.getTime(), tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const weekdayOfYmd = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The occurrence whose GAME is on local `gameDate`. */
export function occurrenceFor(s: WeeklySchedule, gameDate: string): Occurrence {
  return {
    gameDate,
    gameAt: zonedToUtc(gameDate, s.startTime, s.timezone),
    pollAt: zonedToUtc(addDaysYmd(gameDate, -s.pollDaysBefore), s.pollTime, s.timezone),
    cutoffAt: zonedToUtc(addDaysYmd(gameDate, -s.cutoffDaysBefore), s.cutoffTime, s.timezone),
  };
}

/** Occurrences whose game is the previous, the current/next and the following schedule weekday around `now`. */
export function occurrencesAround(s: WeeklySchedule, now: Date): Occurrence[] {
  const today = localYmd(now, s.timezone);
  const ahead = (s.weekday - weekdayOfYmd(today) + 7) % 7;
  const next = addDaysYmd(today, ahead);
  return [addDaysYmd(next, -7), next, addDaysYmd(next, 7)].map((d) => occurrenceFor(s, d));
}

/** The next occurrence whose game has not started yet. */
export function nextOccurrence(s: WeeklySchedule, now: Date): Occurrence {
  return occurrencesAround(s, now).find((o) => o.gameAt.getTime() > now.getTime())!;
}

/**
 * Occurrences that are DUE for match creation + attendance poll: the poll time
 * has come and the attendance cutoff has not (an occurrence whose cutoff already
 * passed is never created retroactively).
 */
export function dueForPoll(s: WeeklySchedule, now: Date): Occurrence[] {
  const t = now.getTime();
  return occurrencesAround(s, now).filter((o) => o.pollAt.getTime() <= t && t < o.cutoffAt.getTime());
}

/** Validation: poll before cutoff, cutoff no later than the game. */
export function scheduleOrderError(s: WeeklySchedule): string | null {
  const o = occurrenceFor(s, "2030-01-07"); // any reference week; order is wall-clock based
  if (!(o.pollAt < o.cutoffAt)) return "The attendance poll must be sent before the attendance cutoff.";
  if (!(o.cutoffAt <= o.gameAt)) return "The attendance cutoff must be at or before the game time.";
  return null;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
