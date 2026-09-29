export function toDateOnlyUTC(input: string | Date) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return new Date(`${y}-${m}-${day}T00:00:00.000Z`);
}

/**
 * Formats a date-only value as a long calendar date, e.g. "October 5, 2026".
 *
 * A YYYY-MM-DD value is a calendar date, not an instant: the app stores it
 * as UTC midnight (see toDateOnlyUTC). Formatting that instant in the
 * browser's or server's local timezone shifts it to the previous day
 * anywhere west of UTC, so this always formats the UTC calendar
 * components (explicit timeZone: "UTC") — never local time. Accepts the
 * forms callers actually hold: "2026-10-05", "2026-10-05T00:00:00.000Z",
 * or a Date at UTC midnight. Returns "" for an invalid value.
 */
export function formatLongDateOnly(value: string | Date): string {
  const d = toDateOnlyUTC(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}
