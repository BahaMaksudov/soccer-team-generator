/**
 * Phase 4B (step 3) — attendance deadlines as organizers read and type them:
 * always in the Group's timezone, with its abbreviation (EDT / EST …).
 * Pure (Intl only) — safe in client components.
 */
function parts(at: Date, tz: string, options: Intl.DateTimeFormatOptions) {
  const list = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options }).formatToParts(at);
  return (type: Intl.DateTimeFormatPartTypes) => list.find((p) => p.type === type)?.value ?? "";
}

/** "EDT" — the zone's short name at that instant. */
export function timeZoneAbbreviation(tz: string, at: Date = new Date()): string {
  return parts(at, tz, { timeZoneName: "short" })("timeZoneName");
}

/** "Monday, October 19 at 8:00 PM EDT" (the year is added when it isn't the current one in that zone). */
export function formatDeadline(iso: string, tz: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const get = parts(at, tz, { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const year = get("year") !== parts(now, tz, { year: "numeric" })("year") ? `, ${get("year")}` : "";
  return `${get("weekday")}, ${get("month")} ${get("day")}${year} at ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

/** The value of an <input type="datetime-local"> in the Group's timezone ("" for none). */
export function toLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const get = parts(new Date(iso), tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Kickoff as the same local "YYYY-MM-DDTHH:MM" (end of the game day without a start time) — for a same-zone comparison. */
export function localKickoff(date: string, startTime: string | null | undefined): string {
  if (startTime) return `${date}T${startTime}`;
  const [y, m, d] = date.split("-").map(Number);
  return `${new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)}T00:00`;
}
