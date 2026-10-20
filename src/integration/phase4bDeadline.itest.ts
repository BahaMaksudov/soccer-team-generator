/**
 * Phase 4B step 2 — the shared attendance-deadline rule, REAL DATABASE (guarded
 * local test DB only). Telegram is a stub (no real calls); emails go to the
 * test outbox. Game dates are far in the future and every instant is computed,
 * so nothing depends on today's date. No Game Day Update exists yet.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as scheduleRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as pollCloseRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { setOwnAttendance } from "@/lib/matches";
import { answerPersonal } from "@/lib/personalAttendance";
import { generateToken, hashToken } from "@/lib/secureToken";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { addDaysYmd, weekdayOfYmd, zonedToUtc } from "@/lib/scheduleTime";
import { testOutbox } from "@/lib/email/transport";

const TZ = "America/New_York";
/** M12B — a personal attendance link for one player of a match (the player-answer path that replaced name-pick). */
async function personalLink(matchId: string, playerId: string): Promise<string> {
  const token = generateToken();
  const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { groupId: true, group: { select: { organizationId: true } } } });
  await prisma.personalAttendanceLink.create({ data: { organizationId: m.group.organizationId, groupId: m.groupId, matchId, playerId, tokenHash: hashToken(token) } });
  return token;
}
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const H = 3600_000;
let tgCalls: string[] = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown): Promise<Response> {
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/bot")) {
    tgCalls.push(u.split("/").pop()!);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, poll: { id: `p${tgCalls.length}` } } }) } as unknown as Response;
  }
  otherNetwork++;
  throw new Error("network access is forbidden in integration tests");
}

const json = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const g = (org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const gm = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const gs = (scheduleId: string) => ({ params: Promise.resolve({ organizationSlug: "o", groupSlug: "g", scheduleId }) });
const patch = (matchId: string, body: unknown, org?: string, group?: string) => call(matchRoute.PATCH(json("PATCH", body), gm(matchId, org, group)));
const close = (matchId: string, body: unknown, org?: string, group?: string) => call(closeRoute.POST(json("POST", body), gm(matchId, org, group)));
const view = async (matchId: string) => (await call(matchRoute.GET(json("GET"), gm(matchId)))).body as { match: { attendanceClosed: boolean; attendanceDeadlineAt: string | null } };
const m = (id: string) => prisma.match.findUniqueOrThrow({ where: { id }, include: { automation: true } });

// A far-future recurring Monday game: 21:00 New York, poll 1 day before 20:00, cutoff same day 20:00.
const GAME = (() => {
  let d = "2099-06-01";
  while (weekdayOfYmd(d) !== 1) d = addDaysYmd(d, 1);
  return d;
})();
const SCHED = { groupId: "g", communityId: "c", timezone: TZ, weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
const POLL_AT = zonedToUtc(addDaysYmd(GAME, -1), "20:00", TZ);
const CUTOFF = zonedToUtc(GAME, "20:00", TZ);
const AFTER_POLL = new Date(POLL_AT.getTime() + 5 * 60_000);
const AFTER_CUTOFF = new Date(CUTOFF.getTime() + 5 * 60_000);

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "PersonalAttendanceLink","Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "member", "other", "player"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.create({ data: { id: "o", name: "Org", slug: "o", plan: "LEGACY" } });
  await prisma.organization.create({ data: { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" } });
  await prisma.group.create({ data: { id: "g", organizationId: "o", name: "G", slug: "g", sportKey: "soccer", timezone: TZ, visibility: "LINK" } });
  await prisma.group.create({ data: { id: "g2", organizationId: "o2", name: "G2", slug: "g2", sportKey: "soccer", timezone: TZ } });
  await prisma.community.create({ data: { id: "c", groupId: "g", name: "Mondays" } });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
    ],
  });
  await prisma.player.create({ data: { id: "p1", groupId: "g", firstName: "Pat", lastName: "Player", position: "MIDFIELDER", rating: "GOOD", stamina: 3, userId: "u-player" } });
  await prisma.communityPlayer.create({ data: { groupId: "g", communityId: "c", playerId: "p1" } });
  await prisma.telegramUserLink.create({ data: { groupId: "g", userId: 111n, playerId: "p1" } });
}
/** A manual (community-less) Match far in the future. */
const manual = (id: string, data: Record<string, unknown> = {}) => prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", ...data } });

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("MATCH_SHARE_SECRET", "phase4b-integration-test-secret-0123456789abc");
});
beforeEach(async () => {
  tgCalls = [];
  testOutbox.sent.length = 0;
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("Phase 4B — manual match deadlines (service layer)", () => {
  it("create: optional local deadline in the Group's timezone, validated before kickoff and in the future", async () => {
    const ok = await call(matchesRoute.POST(json("POST", { date: "2099-06-03", startTime: "21:00", attendanceDeadline: "2099-06-03T18:00" }), g()));
    expect(ok.status).toBe(201);
    expect((ok.body.match as { attendanceDeadlineAt: string }).attendanceDeadlineAt).toBe("2099-06-03T22:00:00.000Z"); // 18:00 EDT
    const none = await call(matchesRoute.POST(json("POST", { date: "2099-06-04" }), g()));
    expect((none.body.match as { attendanceDeadlineAt: unknown }).attendanceDeadlineAt).toBeNull();
    expect(await call(matchesRoute.POST(json("POST", { date: "2099-06-03", startTime: "21:00", attendanceDeadline: "2099-06-03T21:00" }), g()))).toMatchObject({ status: 400, body: { error: "The attendance deadline must be before kickoff." } });
    expect(await call(matchesRoute.POST(json("POST", { date: "2099-06-03", attendanceDeadline: "2020-01-01T10:00" }), g()))).toMatchObject({ status: 400, body: { error: "The attendance deadline must be in the future." } });
    // Without a start time, the deadline must be before the end of the game day.
    expect((await call(matchesRoute.POST(json("POST", { date: "2099-06-05", attendanceDeadline: "2099-06-05T23:59" }), g()))).status).toBe(201);
    expect((await call(matchesRoute.POST(json("POST", { date: "2099-06-05", attendanceDeadline: "2099-06-06T00:00" }), g()))).status).toBe(400);
  });

  it("DST: a nonexistent local time is rejected; a repeated one resolves to the earlier instant", async () => {
    const sunday = (month: number, nth: number) => {
      let d = `2099-${String(month).padStart(2, "0")}-01`;
      while (weekdayOfYmd(d) !== 0) d = addDaysYmd(d, 1);
      return addDaysYmd(d, 7 * (nth - 1));
    };
    const springForward = sunday(3, 2);
    const fallBack = sunday(11, 1);
    const gap = await call(matchesRoute.POST(json("POST", { date: addDaysYmd(springForward, 1), attendanceDeadline: `${springForward}T02:30` }), g()));
    expect(gap.status).toBe(400);
    expect(String(gap.body.error)).toMatch(/doesn't exist in America\/New_York/);
    const repeated = await call(matchesRoute.POST(json("POST", { date: addDaysYmd(fallBack, 1), attendanceDeadline: `${fallBack}T01:30` }), g()));
    expect((repeated.body.match as { attendanceDeadlineAt: string }).attendanceDeadlineAt).toBe(zonedToUtc(fallBack, "01:30", TZ).toISOString());
    expect(new Date((repeated.body.match as { attendanceDeadlineAt: string }).attendanceDeadlineAt).getUTCHours()).toBe(5); // 01:30 EDT (UTC−4), the earlier one
  });

  it("existing manual matches without a deadline are unchanged: open until closed by hand; automation never touches them", async () => {
    await manual("m-none");
    const run = await runMatchAutomation(new Date("2099-06-10T00:00:00Z"));
    expect(run.deadlinesClosed).toBe(0);
    expect((await m("m-none")).attendanceClosedAt).toBeNull();
    expect((await view("m-none")).match.attendanceClosed).toBe(false);
  });

  it("edit: set / change / clear while open; refused once closed; kickoff moved before the deadline is refused", async () => {
    await manual("mm");
    expect((await patch("mm", { attendanceDeadline: "2099-06-03T18:00" })).status).toBe(200);
    expect((await m("mm")).attendanceDeadlineAt).toEqual(new Date("2099-06-03T22:00:00Z"));
    expect(await patch("mm", { startTime: "17:00" })).toMatchObject({ status: 400, body: { code: "DEADLINE_AFTER_KICKOFF" } });
    expect((await patch("mm", { startTime: "17:00", attendanceDeadline: "2099-06-03T16:00" })).status).toBe(200);
    expect((await patch("mm", { attendanceDeadline: null })).status).toBe(200);
    expect((await m("mm")).attendanceDeadlineAt).toBeNull();
    expect((await close("mm", { closed: true })).status).toBe(200);
    expect(await patch("mm", { attendanceDeadline: "2099-06-03T16:00" })).toMatchObject({ status: 409, body: { code: "ATTENDANCE_CLOSED" } });
  });
});

describe("Phase 4B — one rule on every path (deadline passed, cron not run yet)", () => {
  it("Match Link, Telegram, My Games and organizer overrides refuse after the deadline; the views say closed", async () => {
    await manual("mx", { attendanceDeadlineAt: new Date(Date.now() - 60_000) });
    const match = await m("mx");
    expect(match.attendanceClosedAt).toBeNull(); // nothing finalized it
    void match;
    expect(await answerPersonal(await personalLink("mx", "p1"), "PLAYING")).toEqual({ ok: false, reason: "closed" });
    expect(await setOwnAttendance("u-player", "mx", "PLAYING")).toBe("closed");
    expect(await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mx", groupId: "g", telegramUserId: 111n, optionIds: [0], at: new Date() }))).toBe("closed");
    expect(await call(overrideRoute.POST(json("POST", { playerId: "p1", status: "PLAYING" }), gm("mx")))).toMatchObject({ status: 409, body: { code: "ATTENDANCE_CLOSED" } });
    expect((await view("mx")).match.attendanceClosed).toBe(true);
    expect(await prisma.attendanceResponse.count()).toBe(0);
    // A Telegram answer GIVEN before the deadline (replayed later by a sync) still counts.
    expect(await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mx", groupId: "g", telegramUserId: 111n, optionIds: [0], at: new Date(Date.now() - 120_000) }))).toBe("recorded");
  });

  it("before the deadline every path accepts; a match closed by hand refuses even with a future deadline", async () => {
    await manual("my", { attendanceDeadlineAt: new Date(Date.now() + H) });
    const match = await m("my");
    void match;
    expect(await answerPersonal(await personalLink("my", "p1"), "MAYBE")).toMatchObject({ ok: true });
    expect(await setOwnAttendance("u-player", "my", "PLAYING")).toBe("ok");
    expect((await call(overrideRoute.POST(json("POST", { playerId: "p1", status: "NOT_PLAYING" }), gm("my")))).status).toBe(200);
    await close("my", { closed: true });
    expect(await setOwnAttendance("u-player", "my", "PLAYING")).toBe("closed");
  });

  it("canceled matches refuse answers and are never finalized", async () => {
    await manual("mc", { status: "CANCELED", attendanceDeadlineAt: new Date(Date.now() - H) });
    expect(await setOwnAttendance("u-player", "mc", "PLAYING")).toBe("not_found");
    await runMatchAutomation(new Date());
    expect((await m("mc")).attendanceClosedAt).toBeNull();
  });
});

describe("Phase 4B — automation finalizes passed deadlines (manual: no email; history untouched)", () => {
  it("a manual match is closed at its passed deadline (Telegram poll closed), once, with no organizer email", async () => {
    await manual("mf", { attendanceDeadlineAt: new Date(Date.now() - H) });
    await prisma.telegramChat.create({ data: { id: 7, chatId: -100n, title: "Chat", groupId: "g" } });
    await prisma.telegramPoll.create({ data: { pollId: "tp", chatId: -100n, messageId: 5n, question: "Q", optionsJson: "[]", groupId: "g", matchId: "mf", kind: "ATTENDANCE" } });
    const now = new Date();
    const run = await runMatchAutomation(now);
    expect(run).toMatchObject({ deadlinesClosed: 1, cutoffs: 0, notified: 0, errors: [] });
    expect((await m("mf")).attendanceClosedAt).toEqual(now);
    expect(tgCalls).toContain("stopPoll");
    expect(await prisma.matchAutomationEmail.count()).toBe(0);
    expect(testOutbox.sent).toHaveLength(0);
    expect((await runMatchAutomation(new Date())).deadlinesClosed).toBe(0); // idempotent
  });

  it("COMPLETED manual matches and deadlines outside the 48 h catch-up window are not rewritten (still closed by the rule)", async () => {
    await manual("mdone", { status: "COMPLETED", attendanceDeadlineAt: new Date(Date.now() - H) });
    await manual("mold", { attendanceDeadlineAt: new Date(Date.now() - 72 * H) });
    expect((await runMatchAutomation(new Date())).deadlinesClosed).toBe(0);
    expect((await m("mdone")).attendanceClosedAt).toBeNull();
    expect((await m("mold")).attendanceClosedAt).toBeNull();
    expect((await view("mold")).match.attendanceClosed).toBe(true);
  });
});

describe("Phase 4B — recurring matches: one deadline, synchronized, reopening respected", () => {
  async function recurring() {
    const s = await prisma.matchSchedule.create({ data: SCHED });
    expect((await runMatchAutomation(AFTER_POLL)).created).toBe(1);
    return { schedule: s, match: await prisma.match.findFirstOrThrow({ where: { scheduleId: s.id }, include: { automation: true } }) };
  }

  it("a new recurring match's deadline IS its automation cutoff", async () => {
    const { match } = await recurring();
    expect(match.attendanceDeadlineAt).toEqual(CUTOFF);
    expect(match.automation!.cutoffDueAt).toEqual(CUTOFF);
  });

  it("deadline edits update Match and MatchAutomation together; clearing leaves the cutoff as history and nothing closes it", async () => {
    const { match } = await recurring();
    expect((await patch(match.id, { attendanceDeadline: `${GAME}T18:00` })).status).toBe(200);
    const moved = await m(match.id);
    expect(moved.attendanceDeadlineAt).toEqual(zonedToUtc(GAME, "18:00", TZ));
    expect(moved.automation!.cutoffDueAt).toEqual(moved.attendanceDeadlineAt);
    expect((await patch(match.id, { attendanceDeadline: null })).status).toBe(200);
    const cleared = await m(match.id);
    expect(cleared.attendanceDeadlineAt).toBeNull();
    expect(cleared.automation!.cutoffDueAt).toEqual(zonedToUtc(GAME, "18:00", TZ)); // history only
    expect(await runMatchAutomation(AFTER_CUTOFF)).toMatchObject({ cutoffs: 0, deadlinesClosed: 0 });
    expect((await m(match.id)).attendanceClosedAt).toBeNull();
  });

  it("the date of a schedule-created match is locked (no duplicate occurrence); time and venue may change", async () => {
    const { match } = await recurring();
    expect(await patch(match.id, { date: addDaysYmd(GAME, 1) })).toMatchObject({ status: 409, body: { code: "RECURRING_DATE_LOCKED" } });
    expect((await patch(match.id, { date: GAME, startTime: "21:30" })).status).toBe(200); // same date is fine
    const venue = await prisma.venue.create({ data: { organizationId: "o", name: "ForeKicks" } });
    expect((await patch(match.id, { venueId: venue.id })).status).toBe(200);
    expect(await patch(match.id, { startTime: "19:00" })).toMatchObject({ status: 400, body: { code: "DEADLINE_AFTER_KICKOFF" } }); // kickoff before the 20:00 cutoff
    await runMatchAutomation(new Date(AFTER_POLL.getTime() + H));
    expect(await prisma.match.count({ where: { scheduleId: match.scheduleId } })).toBe(1);
  });

  it("schedule edits never recreate an existing occurrence (same weekday); a weekday change adds the NEW weekday's occurrence", async () => {
    const { schedule, match } = await recurring();
    expect((await call(scheduleRoute.PATCH(json("PATCH", { startTime: "20:45", cutoffTime: "19:30", pollTime: "19:00" }), gs(schedule.id)))).status).toBe(200);
    await runMatchAutomation(new Date(AFTER_POLL.getTime() + H));
    expect(await prisma.match.findMany({ where: { scheduleId: schedule.id }, select: { id: true } })).toEqual([{ id: match.id }]);
    expect((await m(match.id)).attendanceDeadlineAt).toEqual(CUTOFF); // the existing match keeps its own deadline
    // Weekday Monday → Tuesday: Tuesday's game is a different occurrence (created at its own poll time).
    expect((await call(scheduleRoute.PATCH(json("PATCH", { weekday: 2 }), gs(schedule.id)))).status).toBe(200);
    await runMatchAutomation(new Date(zonedToUtc(GAME, "19:05", TZ)));
    const dates = (await prisma.match.findMany({ where: { scheduleId: schedule.id }, select: { date: true }, orderBy: { date: "asc" } })).map((x) => x.date.toISOString().slice(0, 10));
    expect(dates).toEqual([GAME, addDaysYmd(GAME, 1)]);
  });

  it("reopening after the cutoff: requires a new deadline or 'none'; never closed again by the old cutoff; organizers are not emailed twice", async () => {
    const { match } = await recurring();
    expect(await runMatchAutomation(AFTER_CUTOFF)).toMatchObject({ cutoffs: 1, notified: 1 });
    const emails = await prisma.matchAutomationEmail.count();
    expect(emails).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AFTER_CUTOFF.getTime() + 60_000));
    try {
      expect(await close(match.id, { closed: false })).toMatchObject({ status: 409, body: { code: "DEADLINE_PASSED" } });
      expect(await close(match.id, { closed: false, attendanceDeadline: `${GAME}T19:00` })).toMatchObject({ status: 400, body: { error: "The attendance deadline must be in the future." } });
      expect((await close(match.id, { closed: false, attendanceDeadline: null })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const reopened = await m(match.id);
    expect(reopened).toMatchObject({ attendanceClosedAt: null, attendanceDeadlineAt: null });
    expect(await runMatchAutomation(new Date(AFTER_CUTOFF.getTime() + 2 * 60_000))).toMatchObject({ cutoffs: 0, deadlinesClosed: 0, notified: 0 });
    expect((await m(match.id)).attendanceClosedAt).toBeNull();
    expect(await prisma.matchAutomationEmail.count()).toBe(emails);
  });

  it("reopening with a new future deadline: synchronized, and closed again at that deadline without a second email", async () => {
    const { match } = await recurring();
    await runMatchAutomation(AFTER_CUTOFF);
    const emails = await prisma.matchAutomationEmail.count();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER_CUTOFF);
    try {
      expect((await close(match.id, { closed: false, attendanceDeadline: `${GAME}T20:30` })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const newDeadline = zonedToUtc(GAME, "20:30", TZ);
    expect(await m(match.id)).toMatchObject({ attendanceClosedAt: null, attendanceDeadlineAt: newDeadline, automation: expect.objectContaining({ cutoffDueAt: newDeadline }) });
    expect(await runMatchAutomation(new Date(newDeadline.getTime() + 60_000))).toMatchObject({ deadlinesClosed: 1, cutoffs: 0, notified: 0 });
    expect((await m(match.id)).attendanceClosedAt).not.toBeNull();
    expect(await prisma.matchAutomationEmail.count()).toBe(emails);
  });

  it("an intentionally reopened match from before the migration (deadline NULL, old cutoff passed) stays open everywhere", async () => {
    await manual("r-old", { communityId: "c", attendanceDeadlineAt: null });
    await prisma.matchAutomation.create({ data: { matchId: "r-old", groupId: "g", pollDueAt: new Date(Date.now() - 48 * H), cutoffDueAt: new Date(Date.now() - H), cutoffCompletedAt: new Date(Date.now() - H), notifiedAt: new Date(Date.now() - H) } });
    expect((await view("r-old")).match.attendanceClosed).toBe(false);
    expect(await setOwnAttendance("u-player", "r-old", "PLAYING")).toBe("ok");
    const match = await m("r-old");
    void match;
    expect(await answerPersonal(await personalLink("r-old", "p1"), "MAYBE")).toMatchObject({ ok: true });
    expect(await runMatchAutomation(new Date())).toMatchObject({ cutoffs: 0, deadlinesClosed: 0 });
    expect((await m("r-old")).attendanceClosedAt).toBeNull();
  });
});

describe("Phase 4B — concurrency, permissions, tenant isolation", () => {
  it("parallel deadline edits: Match and MatchAutomation always end equal (never mixed)", async () => {
    await prisma.matchSchedule.create({ data: SCHED });
    await runMatchAutomation(AFTER_POLL);
    const match = await prisma.match.findFirstOrThrow({ where: { scheduleId: { not: null } } });
    const times = ["17:00", "17:15", "17:30", "17:45", "18:00"];
    const results = await Promise.all(times.map((t) => patch(match.id, { attendanceDeadline: `${GAME}T${t}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const after = await m(match.id);
    expect(after.automation!.cutoffDueAt).toEqual(after.attendanceDeadlineAt);
    expect(times.map((t) => zonedToUtc(GAME, t, TZ).getTime())).toContain(after.attendanceDeadlineAt!.getTime());
  });

  it("reopen-with-deadline racing an automation run: either order ends open with the new, synchronized deadline", async () => {
    await manual("race", { attendanceDeadlineAt: new Date(Date.now() - 60_000) });
    const future = new Date(Date.now() + 24 * H);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(future).replace(" ", "T");
    const [reopen] = await Promise.all([close("race", { closed: false, attendanceDeadline: local }), runMatchAutomation(new Date())]);
    expect(reopen.status).toBe(200);
    const after = await m("race");
    expect(after.attendanceClosedAt).toBeNull();
    expect(after.attendanceDeadlineAt!.getTime()).toBe(zonedToUtc(local.slice(0, 10), local.slice(11), TZ).getTime());
  });

  it("MEMBERs and other organizations cannot change deadlines or reopen (generic 404); nothing changes", async () => {
    await manual("mt", { attendanceDeadlineAt: new Date("2099-06-03T22:00:00Z") });
    signIn("member");
    expect((await patch("mt", { attendanceDeadline: null })).status).toBe(404);
    expect((await close("mt", { closed: false, attendanceDeadline: null })).status).toBe(404);
    signIn("other");
    expect((await patch("mt", { attendanceDeadline: null }, "o2", "g2")).status).toBe(404); // via their own group
    expect((await patch("mt", { attendanceDeadline: null })).status).toBe(404); // via ours
    expect((await m("mt")).attendanceDeadlineAt).toEqual(new Date("2099-06-03T22:00:00Z"));
  });
});

describe("Phase 4B step 3 — what the match page receives, and Telegram poll consistency", () => {
  it("the view carries the deadline, the Group timezone and the recurring flag (date lock)", async () => {
    await manual("mv", { attendanceDeadlineAt: new Date("2099-06-03T22:00:00Z") });
    const v = (await call(matchRoute.GET(json("GET"), gm("mv")))).body as { timezone: string; match: { attendanceDeadlineAt: string; attendanceClosed: boolean; recurring: boolean } };
    expect(v.timezone).toBe(TZ);
    expect(v.match).toMatchObject({ attendanceDeadlineAt: "2099-06-03T22:00:00.000Z", attendanceClosed: false, recurring: false });
    await prisma.matchSchedule.create({ data: SCHED });
    await runMatchAutomation(AFTER_POLL);
    const rec = await prisma.match.findFirstOrThrow({ where: { scheduleId: { not: null } } });
    expect(((await call(matchRoute.GET(json("GET"), gm(rec.id)))).body.match as { recurring: boolean }).recurring).toBe(true);
    signIn("member");
    expect(((await call(matchRoute.GET(json("GET"), gm("mv")))).body as { canManage: boolean }).canManage).toBe(false); // no edit controls for MEMBERs
  });

  it("no new attendance poll once attendance is closed (by hand or by a passed deadline); allowed while open", async () => {
    await prisma.telegramChat.create({ data: { id: 9, chatId: -900n, title: "Chat", groupId: "g" } });
    await manual("mp", { attendanceDeadlineAt: new Date(Date.now() + H), telegramChatId: 9 });
    expect((await call(pollRoute.POST(json("POST", { chatRef: 9, intent: "post" }), gm("mp")))).status).toBe(201);
    await prisma.match.update({ where: { id: "mp" }, data: { attendanceDeadlineAt: new Date(Date.now() - 60_000) } });
    const sends = tgCalls.filter((c) => c === "sendPoll").length;
    expect(await call(pollRoute.POST(json("POST", { chatRef: 9, intent: "post_updated" }), gm("mp")))).toMatchObject({ status: 409, body: { code: "ATTENDANCE_CLOSED" } });
    expect(tgCalls.filter((c) => c === "sendPoll").length).toBe(sends);
    // The organizer can still close that ONE poll in Telegram (never in bulk).
    expect((await call(pollCloseRoute.POST(json("POST"), gm("mp")))).status).toBe(200);
    expect(tgCalls).toContain("stopPoll");
    expect((await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: "mp" } })).isClosed).toBe(true);
  });

  it("automation skips posting the poll for a recurring match already closed by hand (no error recorded)", async () => {
    await prisma.telegramChat.create({ data: { id: 8, chatId: -800n, title: "Chat", groupId: "g", communityId: "c" } });
    const s = await prisma.matchSchedule.create({ data: SCHED });
    const match = await prisma.match.create({ data: { groupId: "g", communityId: "c", date: new Date(`${GAME}T00:00:00Z`), startTime: "21:00", scheduleId: s.id, telegramChatId: 8, attendanceDeadlineAt: CUTOFF, attendanceClosedAt: new Date() } });
    await prisma.matchAutomation.create({ data: { matchId: match.id, groupId: "g", pollDueAt: POLL_AT, cutoffDueAt: CUTOFF } });
    expect(await runMatchAutomation(AFTER_POLL)).toMatchObject({ created: 0, pollsPosted: 0, errors: [] });
    expect(tgCalls).not.toContain("sendPoll");
    expect(await prisma.matchAutomation.findFirstOrThrow({ where: { matchId: match.id } })).toMatchObject({ pollPostedAt: null, lastError: null });
  });
});

describe("network safety", () => {
  it("no unexpected network call", () => {
    expect(otherNetwork).toBe(0);
  });
});
