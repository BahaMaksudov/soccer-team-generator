import { describe, it, expect } from "vitest";
import { runFeedback } from "@/lib/automationFeedback";

/** M9.2.1 — Run now feedback reports only what actually happened. */
const base = { ok: true, paused: false, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, issues: [] as string[] };

describe("runFeedback", () => {
  it("nothing due → never claims an action", () => {
    expect(runFeedback(base)).toEqual({ tone: "done", text: "Automation checked successfully — nothing was due right now." });
  });
  it("lists exactly the steps that ran", () => {
    expect(runFeedback({ ...base, created: 1, pollsPosted: 1 }).text).toBe("Automation checked successfully: Match created, Attendance poll posted.");
    expect(runFeedback({ ...base, cutoffs: 1, notified: 1 }).text).toBe("Automation checked successfully: Attendance finalized, Organizers notified.");
  });
  it("paused schedules say they stay paused", () => {
    expect(runFeedback({ ...base, paused: true }).text).toMatch(/nothing was due right now\. Automation stays paused\.$/);
  });
  it("problems are shown as organizer messages with what did happen", () => {
    const fb = runFeedback({ ...base, ok: false, created: 1, issues: ["The attendance poll could not be posted: no connected Telegram group for UCCNE."] });
    expect(fb).toEqual({ tone: "warn", text: "Automation ran with problems. Done: Match created.", details: ["The attendance poll could not be posted: no connected Telegram group for UCCNE."] });
  });
});
