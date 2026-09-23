import { describe, it, expect } from "vitest";
import { toDateOnlyUTC } from "../dateOnly";

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
