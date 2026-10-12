import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gameDayUpdateDecision, MIN_LEFT_MS, POLL_SETTLE_MS, type GameDayFacts } from "@/lib/gameDayUpdateSchedule";
import { statusOf } from "@/lib/gameDayUpdate";

/** Phase 4B step 6 — when a Game Day Update may be sent (pure). */
const H = 3600_000;
const D = new Date("2099-06-03T21:00:00Z");
const at = (ms: number) => new Date(D.getTime() + ms);
const facts = (over: Partial<GameDayFacts> = {}): GameDayFacts => ({
  enabled: true,
  hoursBefore: 4,
  telegramAllowed: true,
  matchStatus: "SCHEDULED",
  attendanceClosedAt: null,
  attendanceDeadlineAt: D,
  schedule: "none",
  poll: { postedAt: at(-24 * H), chatConnected: true },
  delivery: null,
  ...over,
});

describe("timing", () => {
  it("dueAt = max(deadline − offset, poll + 60 min); send between dueAt and deadline − 30 min", () => {
    expect(POLL_SETTLE_MS).toBe(60 * 60_000);
    expect(MIN_LEFT_MS).toBe(30 * 60_000);
    for (const h of [2, 4, 6, 12]) {
      expect(gameDayUpdateDecision(facts({ hoursBefore: h }), at(-h * H - 1))).toEqual({ kind: "wait", dueAt: at(-h * H) });
      expect(gameDayUpdateDecision(facts({ hoursBefore: h }), at(-h * H))).toEqual({ kind: "send", dueAt: at(-h * H), retry: false });
    }
    expect(gameDayUpdateDecision(facts({ poll: { postedAt: at(-3 * H), chatConnected: true } }), at(-2.5 * H))).toEqual({ kind: "wait", dueAt: at(-2 * H) });
    expect(gameDayUpdateDecision(facts(), at(-31 * 60_000)).kind).toBe("send"); // late but eligible
    expect(gameDayUpdateDecision(facts(), at(-29 * 60_000))).toMatchObject({ kind: "blocked", reason: "TOO_CLOSE" });
    expect(gameDayUpdateDecision(facts({ poll: { postedAt: at(-80 * 60_000), chatConnected: true } }), at(-2 * H))).toMatchObject({ kind: "blocked", reason: "TOO_CLOSE" });
    expect(gameDayUpdateDecision(facts(), at(1))).toMatchObject({ kind: "blocked", reason: "CLOSED" });
  });
});

describe("eligibility and delivery state", () => {
  it("SENT is final; UNCERTAIN / abandoned SENDING are never retried; FAILED is retried while eligible", () => {
    const now = at(-3 * H);
    expect(gameDayUpdateDecision(facts({ delivery: { status: "SENT", claimedAt: now, sentAt: now, failedAt: null }, enabled: false }), now)).toMatchObject({ kind: "blocked", reason: "SENT" });
    expect(gameDayUpdateDecision(facts({ delivery: { status: "UNCERTAIN", claimedAt: now, sentAt: null, failedAt: now } }), now)).toMatchObject({ reason: "UNCERTAIN" });
    expect(gameDayUpdateDecision(facts({ delivery: { status: "SENDING", claimedAt: at(-3 * H - 10 * 60_000), sentAt: null, failedAt: null } }), now)).toMatchObject({ reason: "UNCERTAIN" });
    expect(gameDayUpdateDecision(facts({ delivery: { status: "SENDING", claimedAt: now, sentAt: null, failedAt: null } }), now)).toMatchObject({ reason: "SENDING" });
    expect(gameDayUpdateDecision(facts({ delivery: { status: "FAILED", claimedAt: now, sentAt: null, failedAt: now } }), now)).toEqual({ kind: "send", dueAt: at(-4 * H), retry: true });
    // Step 7 review — the poll message to reply to is gone: terminal.
    expect(gameDayUpdateDecision(facts({ delivery: { status: "FAILED", claimedAt: now, sentAt: null, failedAt: now, failureCode: "REPLY_TARGET_MISSING" } }), now)).toMatchObject({ kind: "blocked", reason: "POLL_MESSAGE_MISSING" });
  });
  it("blocks in order: disabled, plan, inactive, closed, no deadline, paused, no poll, disconnected", () => {
    const now = at(-3 * H);
    const reason = (f: Partial<GameDayFacts>) => (gameDayUpdateDecision(facts(f), now) as { reason?: string }).reason;
    expect(reason({ enabled: false })).toBe("DISABLED");
    expect(reason({ telegramAllowed: false })).toBe("NOT_IN_PLAN");
    expect(reason({ matchStatus: "CANCELED" })).toBe("INACTIVE");
    expect(reason({ matchStatus: "COMPLETED" })).toBe("INACTIVE");
    expect(reason({ attendanceClosedAt: now })).toBe("CLOSED");
    expect(reason({ attendanceDeadlineAt: null })).toBe("NO_DEADLINE");
    expect(reason({ schedule: "paused" })).toBe("SCHEDULE_PAUSED");
    expect(reason({ schedule: "active" })).toBeUndefined();
    expect(reason({ poll: null })).toBe("NO_POLL");
    expect(reason({ poll: { postedAt: at(-24 * H), chatConnected: false } })).toBe("CHAT_DISCONNECTED");
  });
  it("organizer status texts (no tokens or provider details)", () => {
    expect(statusOf({ kind: "blocked", reason: "UNCERTAIN" })).toEqual({ state: "UNCERTAIN", text: "Delivery uncertain — review the Telegram chat", at: null });
    expect(statusOf({ kind: "blocked", reason: "TOO_CLOSE" }).text).toBe("Not sent: too close to the deadline");
    expect(statusOf({ kind: "wait", dueAt: D })).toEqual({ state: "WAIT", text: "Scheduled", at: D.toISOString() });
    expect(statusOf({ kind: "blocked", reason: "SENT", at: D })).toEqual({ state: "SENT", text: "Sent", at: D.toISOString() });
  });
  it("match page: the status line is organizer-only, in the Group's timezone, with Run now when due", () => {
    const W = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx"), "utf8");
    expect(W).toContain("{view.canManage && view.gameDayUpdate && (");
    expect(W).toContain("formatDeadline(view.gameDayUpdate.at, tz)");
    expect(W).toMatch(/view\.gameDayUpdate\.state === "DUE" \|\| view\.gameDayUpdate\.state === "RETRY"/);
  });
});
