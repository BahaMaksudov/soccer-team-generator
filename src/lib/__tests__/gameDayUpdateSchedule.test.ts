import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gameDayUpdateDecision, manualGameDayDecision, MIN_LEFT_MS, POLL_SETTLE_MS, type GameDayFacts } from "@/lib/gameDayUpdateSchedule";
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
  poll: { postedAt: at(-24 * H), chatConnected: true, chatMatchesMatch: true },
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
    expect(gameDayUpdateDecision(facts({ poll: { postedAt: at(-3 * H), chatConnected: true, chatMatchesMatch: true } }), at(-2.5 * H))).toEqual({ kind: "wait", dueAt: at(-2 * H) });
    expect(gameDayUpdateDecision(facts(), at(-31 * 60_000)).kind).toBe("send"); // late but eligible
    expect(gameDayUpdateDecision(facts(), at(-29 * 60_000))).toMatchObject({ kind: "blocked", reason: "TOO_CLOSE" });
    expect(gameDayUpdateDecision(facts({ poll: { postedAt: at(-80 * 60_000), chatConnected: true, chatMatchesMatch: true } }), at(-2 * H))).toMatchObject({ kind: "blocked", reason: "TOO_CLOSE" });
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
    expect(reason({ poll: { postedAt: at(-24 * H), chatConnected: false, chatMatchesMatch: true } })).toBe("CHAT_DISCONNECTED");
    // Destination consistency: the poll's chat must be the match's selected Telegram group.
    expect(reason({ poll: { postedAt: at(-24 * H), chatConnected: true, chatMatchesMatch: false } })).toBe("CHAT_MISMATCH");
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

describe("manual send (organizer's explicit action)", () => {
  const manual = (f: Partial<GameDayFacts>, now: Date) => manualGameDayDecision(facts(f), now);
  it("independent of the automatic setting, the due time, the 60-minute poll settle and a paused schedule", () => {
    expect(manual({ enabled: false }, at(-10 * H))).toEqual({ kind: "ready", retry: false }); // long before deadline − offset
    expect(manual({ poll: { postedAt: at(-2 * H), chatConnected: true, chatMatchesMatch: true } }, at(-2 * H + 60_000))).toEqual({ kind: "ready", retry: false }); // 1 min after the poll
    expect(manual({ schedule: "paused" }, at(-3 * H)).kind).toBe("ready");
  });
  it("the 30-minute minimum, deadline and closed attendance", () => {
    expect(manual({}, at(-MIN_LEFT_MS)).kind).toBe("ready"); // exactly 30 minutes left
    expect(manual({}, at(-MIN_LEFT_MS + 1))).toMatchObject({ kind: "blocked", reason: "TOO_CLOSE" });
    expect(manual({}, at(0))).toMatchObject({ reason: "CLOSED" });
    expect(manual({ attendanceDeadlineAt: null }, at(-3 * H))).toMatchObject({ reason: "NO_DEADLINE" });
    expect(manual({ attendanceClosedAt: at(-4 * H) }, at(-3 * H))).toMatchObject({ reason: "CLOSED" });
  });
  it("plan, match, poll and destination checks", () => {
    const now = at(-3 * H);
    expect(manual({ telegramAllowed: false }, now)).toMatchObject({ reason: "NOT_IN_PLAN" });
    expect(manual({ matchStatus: "CANCELED" }, now)).toMatchObject({ reason: "INACTIVE" });
    expect(manual({ poll: null }, now)).toMatchObject({ reason: "NO_POLL" });
    expect(manual({ poll: { postedAt: at(-H * 24), chatConnected: false, chatMatchesMatch: true } }, now)).toMatchObject({ reason: "CHAT_DISCONNECTED" });
    expect(manual({ poll: { postedAt: at(-H * 24), chatConnected: true, chatMatchesMatch: false } }, now)).toMatchObject({ reason: "CHAT_MISMATCH" });
  });
  it("one successful update per match: SENT / UNCERTAIN / SENDING / terminal failure block; FAILED may be retried", () => {
    const now = at(-3 * H);
    expect(manual({ delivery: { status: "SENT", claimedAt: now, sentAt: now, failedAt: null } }, now)).toMatchObject({ reason: "SENT" });
    expect(manual({ delivery: { status: "UNCERTAIN", claimedAt: now, sentAt: null, failedAt: now } }, now)).toMatchObject({ reason: "UNCERTAIN" });
    expect(manual({ delivery: { status: "SENDING", claimedAt: now, sentAt: null, failedAt: null } }, now)).toMatchObject({ reason: "SENDING" });
    expect(manual({ delivery: { status: "SENDING", claimedAt: at(-4 * H), sentAt: null, failedAt: null } }, now)).toMatchObject({ reason: "UNCERTAIN" });
    expect(manual({ delivery: { status: "FAILED", claimedAt: now, sentAt: null, failedAt: now, failureCode: "REPLY_TARGET_MISSING" } }, now)).toMatchObject({ reason: "POLL_MESSAGE_MISSING" });
    expect(manual({ delivery: { status: "FAILED", claimedAt: now, sentAt: null, failedAt: now, failureCode: "TELEGRAM_REJECTED" } }, now)).toEqual({ kind: "ready", retry: true });
  });
});

describe("connections inside the Game Day lock (regression: pool-starvation deadlock)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/gameDayUpdate.ts"), "utf8");
  const bodyOf = (start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  it("loadFacts reads ONLY through the passed client (the transaction inside the lock)", () => {
    const loadFacts = bodyOf("async function loadFacts(", "\n}\n");
    expect(loadFacts).not.toMatch(/\bprisma\./);
    expect(loadFacts).toContain("readGameDayUpdateSettings(groupId, db)");
    expect(loadFacts).toContain("organizationPlan(organizationId, now, db)");
  });
  it("every locked transaction body uses only its transaction client", () => {
    const bodies = src.split("prisma.$transaction(async (tx").slice(1).map((b) => b.slice(0, b.indexOf("\n  });")));
    expect(bodies).toHaveLength(3); // automatic send, manual send, mark as sent
    for (const b of bodies) {
      expect(b).toContain("await lockMatch(tx, ");
      expect(b).not.toMatch(/\bprisma\./);
      expect(b).not.toMatch(/loadFacts\([^)]*\bprisma\b/);
    }
  });
});
