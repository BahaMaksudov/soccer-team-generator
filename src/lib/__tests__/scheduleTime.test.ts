import { describe, it, expect } from "vitest";
import { dueForPoll, isValidTimeZone, localYmd, nextOccurrence, occurrenceFor, scheduleOrderError, zonedToUtc, type WeeklySchedule } from "@/lib/scheduleTime";

/** M9.2 — weekly schedule time math (IANA timezones, DST-safe). */
const NY = "America/New_York";
const MONDAY_9PM: WeeklySchedule = { timezone: NY, weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
const iso = (d: Date) => d.toISOString();

describe("zonedToUtc", () => {
  it("standard and daylight time", () => {
    expect(iso(zonedToUtc("2026-01-12", "21:00", NY))).toBe("2026-01-13T02:00:00.000Z"); // EST −5
    expect(iso(zonedToUtc("2026-07-13", "21:00", NY))).toBe("2026-07-14T01:00:00.000Z"); // EDT −4
    expect(iso(zonedToUtc("2026-07-13", "21:00", "UTC"))).toBe("2026-07-13T21:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-13", "21:00", "Asia/Kolkata"))).toBe("2026-07-13T15:30:00.000Z");
  });
  it("fall-back ambiguity → the earlier instant; spring-forward gap → moved forward by the gap", () => {
    expect(iso(zonedToUtc("2026-11-01", "01:30", NY))).toBe("2026-11-01T05:30:00.000Z"); // first 1:30 (EDT)
    expect(iso(zonedToUtc("2027-03-14", "02:30", NY))).toBe("2027-03-14T07:30:00.000Z"); // 2:30 doesn't exist → 3:30 EDT
  });
  it("rejects malformed input; validates IANA names", () => {
    expect(() => zonedToUtc("2026-1-1", "21:00", NY)).toThrow();
    expect(() => zonedToUtc("2026-01-01", "24:00", NY)).toThrow();
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("weekly occurrences", () => {
  it("Monday 9 PM game, poll Sunday 8 PM, cutoff Monday 8 PM — wall times survive the DST change (Nov 1, 2026)", () => {
    const before = occurrenceFor(MONDAY_9PM, "2026-10-26");
    const after = occurrenceFor(MONDAY_9PM, "2026-11-02");
    expect([iso(before.pollAt), iso(before.cutoffAt), iso(before.gameAt)]).toEqual(["2026-10-26T00:00:00.000Z", "2026-10-27T00:00:00.000Z", "2026-10-27T01:00:00.000Z"]);
    expect([iso(after.pollAt), iso(after.cutoffAt), iso(after.gameAt)]).toEqual(["2026-11-02T01:00:00.000Z", "2026-11-03T01:00:00.000Z", "2026-11-03T02:00:00.000Z"]);
    // Poll (Sunday Nov 1, EST) and game (Monday) both keep their local wall time across the transition.
    expect(localYmd(after.pollAt, NY)).toBe("2026-11-01");
  });
  it("spring forward (Mar 14, 2027): the Sunday poll is still 8 PM local", () => {
    const o = occurrenceFor(MONDAY_9PM, "2027-03-15");
    expect(iso(o.pollAt)).toBe("2027-03-15T00:00:00.000Z"); // Sun 20:00 EDT
    expect(iso(o.gameAt)).toBe("2027-03-16T01:00:00.000Z"); // Mon 21:00 EDT
  });
  it("next occurrence and the due window (poll time ≤ now < cutoff)", () => {
    const sundayNoon = new Date("2026-10-25T16:00:00Z"); // Sun 12:00 EDT
    expect(nextOccurrence(MONDAY_9PM, sundayNoon).gameDate).toBe("2026-10-26");
    expect(dueForPoll(MONDAY_9PM, sundayNoon)).toEqual([]);
    const sunday9pm = new Date("2026-10-26T01:00:00Z"); // Sun 21:00 EDT
    expect(dueForPoll(MONDAY_9PM, sunday9pm).map((o) => o.gameDate)).toEqual(["2026-10-26"]);
    const monday830pm = new Date("2026-10-27T00:30:00Z"); // after the cutoff, before the game
    expect(dueForPoll(MONDAY_9PM, monday830pm)).toEqual([]); // never posted retroactively
    expect(nextOccurrence(MONDAY_9PM, new Date("2026-10-27T01:30:00Z")).gameDate).toBe("2026-11-02");
  });
  it("order validation: poll < cutoff ≤ game", () => {
    expect(scheduleOrderError(MONDAY_9PM)).toBeNull();
    expect(scheduleOrderError({ ...MONDAY_9PM, cutoffDaysBefore: 1, cutoffTime: "19:00" })).toMatch(/before the attendance cutoff/);
    expect(scheduleOrderError({ ...MONDAY_9PM, cutoffTime: "22:00" })).toMatch(/at or before the game/);
    expect(scheduleOrderError({ ...MONDAY_9PM, cutoffTime: "21:00" })).toBeNull();
  });
});
