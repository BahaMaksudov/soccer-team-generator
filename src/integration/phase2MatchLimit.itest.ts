/**
 * Phase 2 — Free monthly match allowance (4) and skipped recurring-match
 * warnings, REAL DATABASE (guarded local test DB only). Telegram is a stub;
 * nothing leaves the machine.
 *
 * Organizations: "free" (FREE, trial over), "trial" (FREE, trial running),
 * "pro" (PRO), "comp" (COMP), "legacy" (LEGACY), "other" (another tenant, FREE).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as attendanceRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as schedulesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/route";
import * as scheduleRunRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/run/route";
import * as ackRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/skips/[skipId]/acknowledge/route";
import MatchesPage from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/page";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { planSummary } from "@/lib/entitlements";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
const slugs = (org: string) => ({ organizationSlug: org, groupSlug: `${org}-g` });

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
const g = (org: string) => ({ params: Promise.resolve(slugs(org)) });
const gm = (org: string, matchId: string) => ({ params: Promise.resolve({ ...slugs(org), matchId }) });
const gs = (org: string, scheduleId: string) => ({ params: Promise.resolve({ ...slugs(org), scheduleId }) });
const gk = (org: string, scheduleId: string, skipId: string) => ({ params: Promise.resolve({ ...slugs(org), scheduleId, skipId }) });

const ORGS = ["free", "trial", "pro", "comp", "legacy", "other"] as const;
type Org = (typeof ORGS)[number];
const PLAN: Record<Org, { plan: "FREE" | "PRO" | "COMP" | "LEGACY"; trialEndsAt: Date | null }> = {
  free: { plan: "FREE", trialEndsAt: new Date("2026-01-01T00:00:00Z") }, // a fixed past end: off the trial at every instant used here
  trial: { plan: "FREE", trialEndsAt: new Date("2099-01-01T00:00:00Z") },
  pro: { plan: "PRO", trialEndsAt: null },
  comp: { plan: "COMP", trialEndsAt: null },
  legacy: { plan: "LEGACY", trialEndsAt: null },
  other: { plan: "FREE", trialEndsAt: null },
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MatchScheduleSkip","StripeEvent","BillingCheckoutSession","BillingSubscription","EntitlementEvent","AiUsage","MatchAutomationEmail","MatchAutomation","MatchSchedule","Venue","MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","CommunityPlayer","Community","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupShareLink","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const org of ORGS) {
    await prisma.organization.create({ data: { id: org, name: `Org ${org}`, slug: org, ...PLAN[org] } });
    await prisma.group.create({ data: { id: `${org}-g`, organizationId: org, name: `${org} group`, slug: `${org}-g`, sportKey: "soccer", timezone: "America/New_York" } });
    await prisma.community.create({ data: { id: `${org}-c`, groupId: `${org}-g`, name: `${org} players` } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      ...ORGS.filter((x) => x !== "other").flatMap((org) => [
        { userId: "u-owner", organizationId: org, role: "OWNER" as const },
        { userId: "u-member", organizationId: org, role: "MEMBER" as const },
      ]),
      { userId: "u-other", organizationId: "other", role: "OWNER" },
    ],
  });
}

const newMatch = (org: string, date = "2099-01-05") => call(matchesRoute.POST(json("POST", { date, startTime: "21:00", communityId: `${org}-c` }), g(org)));
const used = async (org: string) => (await planSummary(org)).usage.monthlyMatches.used;
/** Weekly Monday 21:00 New York; poll `pollDaysBefore` days before at 20:00; cutoff on game day 20:00. */
const SCHED = (org: string, pollDaysBefore = 1) => ({ groupId: `${org}-g`, communityId: `${org}-c`, timezone: "America/New_York", weekday: 1, startTime: "21:00", pollDaysBefore, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" });
// Game Monday Oct 26, 2026: poll Sun Oct 25 20:00 EDT (= Oct 26 00:00Z), cutoff Mon Oct 26 20:00 EDT (= Oct 27 00:00Z).
const OCT_POLL = new Date("2026-10-26T00:05:00Z");
const OCT_GAME = new Date("2026-10-26T00:00:00Z");
// Game Monday Nov 2, 2026 (after DST): poll Sun Nov 1 20:00 EST (= Nov 2 01:00Z).
const NOV_POLL = new Date("2026-11-02T01:05:00Z");
/** `n` matches of `org` created at `at` (unrelated to the schedule). */
const fill = (org: string, n: number, at: Date) =>
  prisma.match.createMany({ data: Array.from({ length: n }, (_, i) => ({ id: `${org}-fill-${at.getTime()}-${i}`, groupId: `${org}-g`, communityId: `${org}-c`, date: new Date("2099-03-02"), createdAt: at })) });

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("MATCH_SHARE_SECRET", "phase2-integration-test-secret-0123456789abc");
  vi.stubEnv("BILLING_ENABLED", "");
});
beforeEach(async () => {
  tgCalls = [];
  otherNetwork = 0;
  await seed();
  signIn("owner");
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ============================================================ MANUAL CREATION
describe("Phase 2 — Free: 4 new matches per UTC calendar month", () => {
  it("matches 1–4 are allowed; the 5th is refused (402 PLAN_LIMIT, clear message) and nothing is created", async () => {
    for (let i = 1; i <= 4; i++) expect((await newMatch("free", `2099-01-0${i}`)).status, `#${i}`).toBe(201);
    const fifth = await newMatch("free", "2099-01-05");
    expect(fifth).toMatchObject({
      status: 402,
      body: { code: "PLAN_LIMIT", metric: "monthlyMatches", limit: 4, error: "Your Free plan limit has been reached (4 new matches per month). Pro plans and upgrades are coming soon." },
    });
    expect(await prisma.match.count({ where: { groupId: "free-g" } })).toBe(4);
    expect(await used("free")).toBe(4);
  });

  it("Pro, Complimentary Pro, Legacy and an active Pro trial are unlimited (6 each)", async () => {
    for (const org of ["pro", "comp", "legacy", "trial"] as const) {
      for (let i = 1; i <= 6; i++) expect((await newMatch(org, `2099-02-0${i}`)).status, `${org} #${i}`).toBe(201);
      expect((await planSummary(org)).usage.monthlyMatches).toEqual({ used: 6, limit: null });
    }
    expect((await planSummary("trial")).plan).toBe("TRIAL"); // the trial is NOT treated as Free
  });

  it("month boundary: matches created in the previous UTC month don't count", async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 20));
    await fill("free", 4, lastMonth);
    expect(await used("free")).toBe(0);
    for (let i = 1; i <= 4; i++) expect((await newMatch("free", `2099-01-0${i}`)).status).toBe(201);
    expect((await newMatch("free", "2099-01-09")).status).toBe(402);
  });

  it("concurrent requests cannot exceed 4 (Organization lock): 6 parallel creations → exactly 4", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => newMatch("free", `2099-04-0${i + 1}`)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 402, 402]);
    expect(await prisma.match.count({ where: { groupId: "free-g" } })).toBe(4);
  });

  it("no delete-and-recreate bypass: there is no delete route, and a CANCELED match still counts", async () => {
    expect("DELETE" in matchRoute).toBe(false);
    for (let i = 1; i <= 4; i++) await newMatch("free", `2099-01-0${i}`);
    const any = await prisma.match.findFirstOrThrow({ where: { groupId: "free-g" } });
    expect((await call(matchRoute.PATCH(json("PATCH", { status: "CANCELED" }), gm("free", any.id)))).status).toBe(200);
    expect(await used("free")).toBe(4);
    expect((await newMatch("free", "2099-01-09")).status).toBe(402);
  });

  it("at the limit, editing a match, attendance and team generation still work and consume nothing", async () => {
    for (let i = 1; i <= 4; i++) await newMatch("free", `2099-01-0${i}`);
    const m = await prisma.match.findFirstOrThrow({ where: { groupId: "free-g" } });
    await prisma.player.createMany({ data: Array.from({ length: 4 }, (_, k) => ({ id: `fp${k}`, groupId: "free-g", firstName: `P${k}`, lastName: "T", position: "MIDFIELDER", rating: "GOOD", stamina: 3 })) });
    expect((await call(matchRoute.PATCH(json("PATCH", { startTime: "20:15", locationName: "Field 2" }), gm("free", m.id)))).status).toBe(200);
    expect((await call(attendanceRoute.POST(json("POST", { playerId: "fp0", status: "PLAYING" }), gm("free", m.id)))).status).toBe(200);
    expect((await call(generateRoute.POST(json("POST", { teamCount: 2, date: "2099-06-01", selectedIds: ["fp0", "fp1", "fp2", "fp3"] }), g("free")))).status).toBe(200);
    expect(await used("free")).toBe(4);
    expect(await prisma.match.count({ where: { groupId: "free-g" } })).toBe(4);
  });

  it("the Matches page shows the allowance and blocks New match when it is used up (display only)", async () => {
    await fill("free", 3, new Date());
    let html = renderToStaticMarkup(await MatchesPage({ params: Promise.resolve(slugs("free")) }));
    expect(html).toContain("New matches this month: 3 of 4 on the Free plan");
    await fill("free", 1, new Date(Date.now() + 1));
    html = renderToStaticMarkup(await MatchesPage({ params: Promise.resolve(slugs("free")) }));
    expect(html).toContain("New matches this month: 4 of 4");
    expect(html).toContain("Your Free plan limit has been reached (4 new matches per month).");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?New match/s);
    // Unlimited plans show no allowance; MEMBERs never see it.
    expect(renderToStaticMarkup(await MatchesPage({ params: Promise.resolve(slugs("pro")) }))).not.toContain("New matches this month");
    signIn("member");
    expect(renderToStaticMarkup(await MatchesPage({ params: Promise.resolve(slugs("free")) }))).not.toContain("New matches this month");
  });
});

// ============================================================ RECURRING SCHEDULES
describe("Phase 2 — recurring schedule at the Free limit: skip, warn, keep the schedule", () => {
  const skips = () => prisma.matchScheduleSkip.findMany({ orderBy: { occurrenceDate: "asc" } });

  it("the occurrence is skipped (no match, no poll), recorded once, and the schedule stays active", async () => {
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    await prisma.telegramChat.create({ data: { chatId: -1001n, title: "Chat", groupId: "free-g", communityId: "free-c" } });
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });

    expect(await runMatchAutomation(OCT_POLL)).toMatchObject({ created: 0, limited: 1, pollsPosted: 0, errors: [] });
    expect(await prisma.match.count({ where: { scheduleId: s.id } })).toBe(0);
    expect(await prisma.matchAutomation.count()).toBe(0);
    expect(tgCalls).toEqual([]);
    expect(await skips()).toEqual([
      expect.objectContaining({ groupId: "free-g", scheduleId: s.id, occurrenceDate: OCT_GAME, reason: "MONTHLY_MATCH_LIMIT", monthlyLimit: 4, firstSkippedAt: OCT_POLL, lastSkippedAt: OCT_POLL, resolvedAt: null, acknowledgedAt: null }),
    ]);
    expect(await prisma.matchSchedule.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ isActive: true, weekday: 1, startTime: "21:00", pollDaysBefore: 1 });
  });

  it("cron retries (sequential and concurrent) never duplicate the warning or create a match", async () => {
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });
    await runMatchAutomation(OCT_POLL);
    const later = new Date(OCT_POLL.getTime() + 3600_000);
    await Promise.all([runMatchAutomation(later), runMatchAutomation(later), runMatchAutomation(later)]);
    const rows = await skips();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstSkippedAt: OCT_POLL, lastSkippedAt: later });
    expect(await prisma.match.count({ where: { scheduleId: s.id } })).toBe(0);
  });

  it("a later month creates the next occurrence normally; the skipped one keeps its warning", async () => {
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });
    await runMatchAutomation(OCT_POLL);
    expect(await runMatchAutomation(NOV_POLL)).toMatchObject({ created: 1, limited: 0, errors: [] });
    expect(await prisma.match.findMany({ where: { scheduleId: s.id }, select: { date: true } })).toEqual([{ date: new Date("2026-11-02T00:00:00Z") }]);
    expect(await skips()).toEqual([expect.objectContaining({ occurrenceDate: OCT_GAME, resolvedAt: null })]);
  });

  it("allowance available again before the cutoff (new month): the occurrence is created on a later run and its warning is resolved", async () => {
    // Poll 3 days before: game Mon Nov 2, poll Fri Oct 30 20:00 EDT (= Oct 31 00:00Z, October), cutoff Nov 3 01:00Z.
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const s = await prisma.matchSchedule.create({ data: SCHED("free", 3) });
    expect(await runMatchAutomation(new Date("2026-10-31T00:05:00Z"))).toMatchObject({ created: 0, limited: 1 });
    expect(await runMatchAutomation(new Date("2026-11-01T12:00:00Z"))).toMatchObject({ created: 1, limited: 0 });
    expect(await prisma.match.count({ where: { scheduleId: s.id } })).toBe(1);
    expect((await skips())[0].resolvedAt).toEqual(new Date("2026-11-01T12:00:00Z"));
    signIn("owner");
    expect(((await call(schedulesRoute.GET(json("GET"), g("free")))).body.schedules as Array<{ skips: unknown[] }>)[0].skips).toEqual([]);
  });

  it("the organizer sees the warning (schedules list + Run now), can dismiss it, and it stays dismissed across retries", async () => {
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });
    await runMatchAutomation(OCT_POLL);
    const expected =
      "Your Free plan allows 4 new matches per month. The match scheduled for October 26, 2026 was not created because your monthly limit was reached. Your recurring schedule is still active. Pro plans with unlimited matches are coming soon.";

    const list = await call(schedulesRoute.GET(json("GET"), g("free")));
    const card = (list.body.schedules as Array<{ id: string; isActive: boolean; skips: Array<{ id: string; occurrenceDate: string; message: string }> }>)[0];
    expect(card).toMatchObject({ id: s.id, isActive: true, skips: [{ occurrenceDate: "2026-10-26", message: expected }] });
    expect(card.skips[0].message).not.toMatch(/cancel/i);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(OCT_POLL.getTime() + 60_000));
    const run = await call(scheduleRunRoute.POST(json("POST"), gs("free", s.id)));
    vi.useRealTimers();
    expect(run.body).toMatchObject({ ok: false, created: 0 });
    expect(run.body.issues).toContain(expected);

    expect((await call(ackRoute.POST(json("POST"), gk("free", s.id, card.skips[0].id)))).status).toBe(200);
    expect((await prisma.matchScheduleSkip.findUniqueOrThrow({ where: { id: card.skips[0].id } })).acknowledgedByUserId).toBe("u-owner");
    expect(((await call(schedulesRoute.GET(json("GET"), g("free")))).body.schedules as Array<{ skips: unknown[] }>)[0].skips).toEqual([]);
    await runMatchAutomation(new Date(OCT_POLL.getTime() + 7200_000)); // still due → retried, still limited
    expect(await prisma.matchScheduleSkip.count()).toBe(1);
    expect(((await call(schedulesRoute.GET(json("GET"), g("free")))).body.schedules as Array<{ skips: unknown[] }>)[0].skips).toEqual([]);
    expect((await call(ackRoute.POST(json("POST"), gk("free", s.id, card.skips[0].id)))).status).toBe(200); // idempotent
  });

  it("tenant isolation: another Organization's owner, a MEMBER, and a wrong schedule all get 404; lists never include other Groups' warnings", async () => {
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });
    const o = await prisma.matchSchedule.create({ data: SCHED("other") });
    await runMatchAutomation(OCT_POLL); // "other" has 0 matches → its occurrence is created, no warning
    const [skip] = await skips();
    expect(skip.scheduleId).toBe(s.id);

    signIn("other");
    expect((await call(ackRoute.POST(json("POST"), gk("free", s.id, skip.id)))).status).toBe(404);
    expect((await call(ackRoute.POST(json("POST"), gk("other", o.id, skip.id)))).status).toBe(404); // foreign skip via own schedule
    const otherList = await call(schedulesRoute.GET(json("GET"), g("other")));
    expect(JSON.stringify(otherList.body)).not.toContain(skip.id);
    signIn("member");
    expect((await call(schedulesRoute.GET(json("GET"), g("free")))).status).toBe(404);
    expect((await call(ackRoute.POST(json("POST"), gk("free", s.id, skip.id)))).status).toBe(404);
    signIn("owner");
    expect((await call(ackRoute.POST(json("POST"), gk("free", o.id, skip.id)))).status).toBe(404); // schedule of another Group
    expect((await prisma.matchScheduleSkip.findUniqueOrThrow({ where: { id: skip.id } })).acknowledgedAt).toBeNull();
  });

  it("existing matches, attendance, polls and the schedule are untouched by a skip", async () => {
    await prisma.player.create({ data: { id: "fp", groupId: "free-g", firstName: "F", lastName: "P", position: "MIDFIELDER", rating: "GOOD", stamina: 3 } });
    await fill("free", 4, new Date("2026-10-10T12:00:00Z"));
    const m = await prisma.match.findFirstOrThrow({ where: { groupId: "free-g" } });
    await prisma.attendanceResponse.create({ data: { matchId: m.id, groupId: "free-g", playerId: "fp", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } });
    await prisma.telegramPoll.create({ data: { pollId: "tp1", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "free-g", matchId: m.id } });
    const s = await prisma.matchSchedule.create({ data: SCHED("free") });
    const snapshot = async () => ({
      matches: await prisma.match.findMany({ orderBy: { id: "asc" } }),
      attendance: await prisma.attendanceResponse.findMany({ orderBy: { id: "asc" } }),
      polls: await prisma.telegramPoll.findMany({ orderBy: { pollId: "asc" } }),
      schedule: await prisma.matchSchedule.findUniqueOrThrow({ where: { id: s.id } }),
    });
    const before = await snapshot();
    await runMatchAutomation(OCT_POLL);
    await runMatchAutomation(new Date(OCT_POLL.getTime() + 3600_000));
    expect(await snapshot()).toEqual(before);
    expect(await prisma.matchScheduleSkip.count()).toBe(1);
  });

  it("unlimited plans never record a skip", async () => {
    for (const org of ["pro", "comp", "legacy", "trial"] as const) {
      await fill(org, 10, new Date("2026-10-10T12:00:00Z"));
      await prisma.matchSchedule.create({ data: SCHED(org) });
    }
    expect(await runMatchAutomation(OCT_POLL)).toMatchObject({ created: 4, limited: 0, errors: [] });
    expect(await prisma.matchScheduleSkip.count()).toBe(0);
  });
});

describe("network safety", () => {
  it("no unexpected network call happened", () => {
    expect(otherNetwork).toBe(0);
  });
});
