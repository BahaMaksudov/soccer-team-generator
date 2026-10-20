import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { deadlineNoticeEnabled, closeSummary } from "@/lib/attendanceClosure";

describe("M12B — the deadline closure notice is OFF unless explicitly enabled", () => {
  it("only ATTENDANCE_DEADLINE_NOTICE=on enables it", () => {
    expect(deadlineNoticeEnabled({})).toBe(false);
    expect(deadlineNoticeEnabled({ ATTENDANCE_DEADLINE_NOTICE: "" })).toBe(false);
    expect(deadlineNoticeEnabled({ ATTENDANCE_DEADLINE_NOTICE: "true" })).toBe(false);
    expect(deadlineNoticeEnabled({ ATTENDANCE_DEADLINE_NOTICE: "off" })).toBe(false);
    expect(deadlineNoticeEnabled({ ATTENDANCE_DEADLINE_NOTICE: " ON " })).toBe(true);
  });
  it("organizer summary never claims a closed poll or a notice it didn't confirm", () => {
    expect(closeSummary({ attendance: "closed_now", status: "no_poll", polls: [] })).toBe("Attendance closed.");
    expect(closeSummary({ attendance: "closed_now", status: "uncertain", polls: [{ pollId: "p", close: "close_uncertain", notice: "not_closed" }] })).toContain("may still be open");
    expect(closeSummary({ attendance: "already_closed", status: "closed", polls: [{ pollId: "p", close: "closed_now", notice: "not_in_plan" }] })).toContain("part of Pro");
  });
});
