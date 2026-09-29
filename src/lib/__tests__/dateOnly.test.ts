import { describe, it, expect } from "vitest";
import { toDateOnlyUTC, formatLongDateOnly } from "../dateOnly";

describe("toDateOnlyUTC", () => {
  it("normalizes a YYYY-MM-DD string to UTC midnight of that same calendar day", () => {
    const d = toDateOnlyUTC("2026-01-19");
    expect(d.toISOString()).toBe("2026-01-19T00:00:00.000Z");
  });

  it("round-trips a Date input without shifting the calendar day", () => {
    const input = new Date("2026-06-15T00:00:00.000Z");
    const d = toDateOnlyUTC(input);
    expect(d.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("strips a time-of-day component instead of rolling the date over", () => {
    // A timestamp late in the UTC day must normalize to the SAME day,
    // not the next one — this is the exact class of off-by-one bug the
    // app has hit before.
    const d = toDateOnlyUTC(new Date("2026-03-10T23:59:00.000Z"));
    expect(d.toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });

  it("does not shift across a month boundary", () => {
    const d = toDateOnlyUTC("2026-01-31");
    expect(d.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("does not shift across a year boundary", () => {
    const d = toDateOnlyUTC("2025-12-31");
    expect(d.toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });

  it("is idempotent — normalizing an already-normalized date is a no-op", () => {
    const once = toDateOnlyUTC("2026-07-04");
    const twice = toDateOnlyUTC(once);
    expect(twice.toISOString()).toBe(once.toISOString());
  });
});

// ---------------------------------------------------------------
// Phase 2D.6E.3B — formatLongDateOnly(): date-only display must never
// depend on the runtime (browser/server) timezone.
// ---------------------------------------------------------------

const TIMEZONES = ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
const CASES: Array<[string, string]> = [
  ["2026-10-05", "October 5, 2026"],
  ["2026-01-05", "January 5, 2026"],
  ["2026-03-08", "March 8, 2026"], // US DST starts
  ["2026-03-09", "March 9, 2026"],
  ["2026-11-01", "November 1, 2026"], // US DST ends
  ["2026-11-02", "November 2, 2026"],
  ["2025-12-31", "December 31, 2025"],
];

/** Runs fn with process.env.TZ switched (Node re-reads TZ on assignment). */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("formatLongDateOnly", () => {
  it("control: switching TZ really changes local formatting (so the checks below are not vacuous)", () => {
    const utcMidnight = new Date("2026-10-05T00:00:00.000Z");
    const local = (tz: string) =>
      withTZ(tz, () => utcMidnight.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
    expect(local("UTC")).toBe("October 5, 2026");
    expect(local("America/New_York")).toBe("October 4, 2026"); // the original bug
  });

  for (const tz of TIMEZONES) {
    describe(`TZ=${tz}`, () => {
      it.each(CASES)("%s → %s from YYYY-MM-DD, UTC-midnight ISO string, and Date", (ymd, expected) => {
        withTZ(tz, () => {
          expect(formatLongDateOnly(ymd)).toBe(expected);
          expect(formatLongDateOnly(`${ymd}T00:00:00.000Z`)).toBe(expected);
          expect(formatLongDateOnly(new Date(`${ymd}T00:00:00.000Z`))).toBe(expected);
        });
      });
    });
  }

  it("returns an empty string for an invalid value instead of 'Invalid Date'", () => {
    expect(formatLongDateOnly("")).toBe("");
    expect(formatLongDateOnly("not-a-date")).toBe("");
  });
});
