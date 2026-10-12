import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatDeadline, localKickoff, timeZoneAbbreviation, toLocalInput } from "@/lib/deadlineFormat";

/** Phase 4B step 3 — deadline UI: formatting in the Group's timezone, and the UI contracts. */
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const W = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx");
const C = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/CreateMatchForm.tsx");
const S = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/SchedulesSection.tsx");
const NOW_2026 = new Date("2026-10-12T12:00:00Z");

describe("deadline formatting (Group timezone, DST-aware abbreviations)", () => {
  it("'Monday, October 19 at 8:00 PM EDT' — and EST after the fall-back", () => {
    expect(formatDeadline("2026-10-20T00:00:00.000Z", "America/New_York", NOW_2026)).toBe("Monday, October 19 at 8:00 PM EDT");
    expect(formatDeadline("2026-11-17T01:00:00.000Z", "America/New_York", NOW_2026)).toBe("Monday, November 16 at 8:00 PM EST");
    expect(formatDeadline("2026-11-01T05:30:00.000Z", "America/New_York", NOW_2026)).toBe("Sunday, November 1 at 1:30 AM EDT"); // the earlier 1:30
    expect(formatDeadline("2026-11-01T06:30:00.000Z", "America/New_York", NOW_2026)).toBe("Sunday, November 1 at 1:30 AM EST"); // the later one
  });
  it("adds the year when it isn't the current one; other zones format in their own time", () => {
    expect(formatDeadline("2099-06-03T22:00:00.000Z", "America/New_York", NOW_2026)).toBe("Wednesday, June 3, 2099 at 6:00 PM EDT");
    expect(formatDeadline("2026-10-19T19:00:00.000Z", "Europe/London", NOW_2026)).toMatch(/^Monday, October 19 at 8:00 PM (BST|GMT\+1)$/);
  });
  it("datetime-local values round-trip in the Group's zone", () => {
    expect(toLocalInput("2026-10-20T00:00:00.000Z", "America/New_York")).toBe("2026-10-19T20:00");
    expect(toLocalInput("2026-11-17T01:00:00.000Z", "America/New_York")).toBe("2026-11-16T20:00");
    expect(toLocalInput(null, "America/New_York")).toBe("");
    expect(timeZoneAbbreviation("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe("EDT");
    expect(timeZoneAbbreviation("America/New_York", new Date("2026-12-01T12:00:00Z"))).toBe("EST");
  });
  it("same-zone kickoff for the client check (end of game day without a start time)", () => {
    expect(localKickoff("2026-10-19", "21:00")).toBe("2026-10-19T21:00");
    expect(localKickoff("2026-10-31", null)).toBe("2026-11-01T00:00");
    expect("2026-10-19T20:00" < localKickoff("2026-10-19", "21:00")).toBe(true);
  });
});

describe("UI contracts (the server validates and authorizes everything)", () => {
  it("create form: optional 'Attendance closes' in the Group's timezone; empty = close it yourself; sent only when set", () => {
    expect(C).toContain('type="datetime-local"');
    expect(C).toContain("Attendance closes");
    expect(C).toContain("Leave empty to close attendance yourself.");
    expect(C).toMatch(/Times in \{timezone\} \(\{timeZoneAbbreviation\(timezone\)\}\)/);
    expect(C).toContain("...(form.attendanceDeadline ? { attendanceDeadline: form.attendanceDeadline } : {})");
  });
  it("match header: the enforced deadline or 'Manually by organizer'; Edit deadline for organizers while open", () => {
    expect(W).toContain('"Manually by organizer"');
    expect(W).toMatch(/view\.canManage && !m\.attendanceClosed && m\.status !== "CANCELED" && \(\s*<button[^>]*onClick=\{\(\) => openEdit\(true\)\}/);
  });
  it("edit: one form saves details + deadline (the Step 2 writer); empty removes it; sent only when changed", () => {
    expect(W).toContain("...(deadline !== initialDeadline ? { attendanceDeadline: deadline || null } : {})");
    expect(W).toContain("Remove deadline");
  });
  it("recurring: the date input is disabled, never sent, and the reason is explained", () => {
    expect(W).toContain("disabled={m.recurring}");
    expect(W).toContain("...(m.recurring ? {} : { date })");
    expect(W).toContain("its date can&apos;t be changed here");
  });
  it("reopen: a passed deadline opens the choice (no deadline / new future deadline) — one atomic request; otherwise reopen directly", () => {
    expect(W).toContain("if (deadlinePassed) setReopen(");
    expect(W).toContain('else call("/attendance/close", { closed: false }, "Attendance reopened.")');
    expect(W).toContain('{ closed: false, attendanceDeadline: reopen.choice === "none" ? null : reopen.deadline }');
    expect(W).toContain("Reopen without a deadline");
    expect(W).toContain("Reopen with a new deadline");
  });
  it("Telegram consistency: no new poll while closed; the open-poll warning + per-match close action once attendance is closed", () => {
    expect(W).toContain('disabled={busy || chatRef === null || m.status === "CANCELED" || m.attendanceClosed}');
    expect(W).toContain("(view.generation || m.attendanceClosed)");
    expect(W).toContain("Answers given there now are not counted.");
  });
  it("schedules: changing the game day warns that it creates matches on the new day", () => {
    expect(S).toContain("Changing the game day creates matches on the new day");
  });
});
