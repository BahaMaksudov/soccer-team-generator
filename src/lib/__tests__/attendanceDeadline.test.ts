import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  attendanceIsClosed,
  attendanceState,
  deadlineError,
  DEADLINE_AFTER_KICKOFF,
  DEADLINE_BEFORE_POLL,
  DEADLINE_IN_PAST,
  effectiveClosedAt,
  kickoffAt,
  localDeadlineToUtc,
} from "@/lib/attendanceDeadline";

/** Phase 4B step 2 — the one attendance-deadline rule (pure). */
const t = (iso: string) => new Date(iso);
const NOW = t("2026-10-19T20:00:00Z");

describe("shared attendance state", () => {
  it("closedAt → closed; passed deadline → closed; otherwise open (deadline NULL = open)", () => {
    expect(attendanceState({ attendanceClosedAt: t("2026-10-19T19:00:00Z"), attendanceDeadlineAt: null }, NOW)).toBe("closed");
    expect(attendanceState({ attendanceClosedAt: null, attendanceDeadlineAt: t("2026-10-19T20:00:00Z") }, NOW)).toBe("closed"); // exactly at the deadline
    expect(attendanceState({ attendanceClosedAt: null, attendanceDeadlineAt: t("2026-10-19T20:00:01Z") }, NOW)).toBe("open");
    expect(attendanceState({ attendanceClosedAt: null, attendanceDeadlineAt: null }, NOW)).toBe("open");
    // A future deadline never reopens a match closed by hand.
    expect(attendanceIsClosed({ attendanceClosedAt: t("2026-10-19T19:00:00Z"), attendanceDeadlineAt: t("2026-10-30T00:00:00Z") }, NOW)).toBe(true);
  });
  it("effective closing instant: the explicit close, else a passed deadline, else null", () => {
    expect(effectiveClosedAt({ attendanceClosedAt: t("2026-10-19T19:00:00Z"), attendanceDeadlineAt: t("2026-10-19T18:00:00Z") }, NOW)).toEqual(t("2026-10-19T19:00:00Z"));
    expect(effectiveClosedAt({ attendanceClosedAt: null, attendanceDeadlineAt: t("2026-10-19T18:00:00Z") }, NOW)).toEqual(t("2026-10-19T18:00:00Z"));
    expect(effectiveClosedAt({ attendanceClosedAt: null, attendanceDeadlineAt: t("2026-10-20T18:00:00Z") }, NOW)).toBeNull();
  });
  it("the old automation cutoff is never an independent closure condition", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/matchLink.ts"), "utf8");
    expect(src).not.toMatch(/cutoffDueAt/);
    const auto = fs.readFileSync(path.join(process.cwd(), "src/lib/matchAutomation.ts"), "utf8");
    expect(auto).toContain("attendanceDeadlineAt: windowed, automation: { is: { cutoffCompletedAt: null } }");
  });
});

describe("local deadlines in the Group's timezone (DST)", () => {
  it("converts a normal local time (EDT and EST)", () => {
    expect(localDeadlineToUtc("2026-10-19T20:00", "America/New_York")).toEqual({ ok: true, at: t("2026-10-20T00:00:00Z") }); // EDT
    expect(localDeadlineToUtc("2026-11-16T20:00", "America/New_York")).toEqual({ ok: true, at: t("2026-11-17T01:00:00Z") }); // EST
    expect(localDeadlineToUtc("2026-10-19T20:00", "Europe/London")).toEqual({ ok: true, at: t("2026-10-19T19:00:00Z") });
  });
  it("rejects a time that doesn't exist (spring forward) and resolves a repeated one (fall back) to the earlier instant", () => {
    const gap = localDeadlineToUtc("2027-03-14T02:30", "America/New_York");
    expect(gap.ok).toBe(false);
    expect(!gap.ok && gap.error).toMatch(/doesn't exist in America\/New_York/);
    expect(localDeadlineToUtc("2026-11-01T01:30", "America/New_York")).toEqual({ ok: true, at: t("2026-11-01T05:30:00Z") }); // 01:30 EDT, not EST
  });
  it("rejects malformed input", () => {
    for (const bad of ["2026-10-19 20:00", "2026-10-19T24:00", "2026-13-01T10:00x", ""]) expect(localDeadlineToUtc(bad, "UTC").ok, bad).toBe(false);
  });
  it("kickoff: date + start time in the zone; without a start time, the end of the game day", () => {
    expect(kickoffAt(t("2026-10-19T00:00:00Z"), "21:00", "America/New_York")).toEqual(t("2026-10-20T01:00:00Z"));
    expect(kickoffAt(t("2026-11-02T00:00:00Z"), "21:00", "America/New_York")).toEqual(t("2026-11-03T02:00:00Z"));
    expect(kickoffAt(t("2026-10-31T00:00:00Z"), null, "America/New_York")).toEqual(t("2026-11-01T04:00:00Z")); // midnight EDT into Nov 1
  });
  it("validation: in the future, before kickoff, after a pending poll", () => {
    const kickoff = t("2026-10-20T01:00:00Z");
    expect(deadlineError(t("2026-10-19T19:00:00Z"), kickoff, NOW)).toBe(DEADLINE_IN_PAST);
    expect(deadlineError(kickoff, kickoff, NOW)).toBe(DEADLINE_AFTER_KICKOFF);
    expect(deadlineError(t("2026-10-19T22:00:00Z"), kickoff, NOW, t("2026-10-19T23:00:00Z"))).toBe(DEADLINE_BEFORE_POLL);
    expect(deadlineError(t("2026-10-19T23:30:00Z"), kickoff, NOW, t("2026-10-19T23:00:00Z"))).toBeNull();
  });
});
