/**
 * M11.1 — plans, the introductory trial and entitlements, REAL DATABASE
 * (guarded local test DB only). Telegram and OpenAI are stubs; nothing leaves
 * the machine.
 *
 * Organizations: "free" (FREE, trial over), "trial" (FREE, trial running),
 * "comp" (COMP), "legacy" (grandfathered), "other" (another tenant).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as groupsRoute from "@/app/api/admin/o/[organizationSlug]/groups/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as schedulesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/route";
import * as scheduleRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/route";
import * as keepRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/keep/route";
import * as scheduleRunRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/run/route";
import * as channelsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { aiCreditsUsed, changeEntitlement, planSummary, reserveAiCredit, settleAiCredit, TRIAL_DAYS } from "@/lib/entitlements";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
const slugs = (org: string) => ({ organizationSlug: org, groupSlug: `${org}-g` });

// ------------------------------------------------------------ network stubs
let tgCalls: string[] = [];
let aiCalls = 0;
let aiMode: "ok" | "500" = "ok";
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown): Promise<Response> {
  const u = String(url);
  if (u.startsWith("https://ai.itest/")) {
    aiCalls++;
    if (aiMode === "500") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "What a night! Team 1 won 5–3 in a close one." }] }] }) } as unknown as Response;
  }
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
const signIn = async (who: string | null) => {
  if (!who) return void (session = null);
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};
const g = (org: string) => ({ params: Promise.resolve(slugs(org)) });
const o = (org: string) => ({ params: Promise.resolve({ organizationSlug: org }) });
const gm = (org: string, matchId: string) => ({ params: Promise.resolve({ ...slugs(org), matchId }) });
const gs = (org: string, scheduleId: string) => ({ params: Promise.resolve({ ...slugs(org), scheduleId }) });
const gp = (org: string, id: string) => ({ params: Promise.resolve({ ...slugs(org), id }) });

const ORGS = ["free", "trial", "comp", "legacy", "other"] as const;
const PLAN: Record<(typeof ORGS)[number], { plan: "FREE" | "COMP" | "LEGACY"; trialEndsAt: Date | null }> = {
  free: { plan: "FREE", trialEndsAt: new Date(Date.now() - DAY_MS) },
  trial: { plan: "FREE", trialEndsAt: new Date(Date.now() + 30 * DAY_MS) },
  comp: { plan: "COMP", trialEndsAt: null },
  legacy: { plan: "LEGACY", trialEndsAt: null },
  other: { plan: "FREE", trialEndsAt: null },
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EntitlementEvent","AiUsage","MatchAutomationEmail","MatchAutomation","MatchSchedule","Venue","MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","CommunityPlayer","Community","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupShareLink","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: [
      ...["owner", "admin", "member", "other", "newbie"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
      { id: "u-unverified", email: "unverified@example.test", name: "unverified", passwordHash: null, emailVerifiedAt: null },
    ],
  });
  for (const org of ORGS) {
    await prisma.organization.create({ data: { id: org, name: `Org ${org}`, slug: org, ...PLAN[org] } });
    await prisma.group.create({ data: { id: `${org}-g`, organizationId: org, name: `${org} group`, slug: `${org}-g`, sportKey: "soccer", timezone: "America/New_York" } });
    await prisma.community.create({ data: { id: `${org}-c`, groupId: `${org}-g`, name: `${org} players` } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      ...ORGS.filter((x) => x !== "other").flatMap((org) => [
        { userId: "u-owner", organizationId: org, role: "OWNER" as const },
        { userId: "u-admin", organizationId: org, role: "ADMIN" as const },
        { userId: "u-member", organizationId: org, role: "MEMBER" as const },
      ]),
      { userId: "u-other", organizationId: "other", role: "OWNER" },
    ],
  });
}

const addPlayers = async (org: string, n: number, opts: { active?: boolean; prefix?: string } = {}) => {
  const ids = Array.from({ length: n }, (_, i) => `${org}-${opts.prefix ?? "p"}${i}`);
  await prisma.player.createMany({ data: ids.map((id) => ({ id, groupId: `${org}-g`, firstName: id, lastName: "T", position: "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: opts.active ?? true })) });
  return ids;
};
const newPlayer = (org: string, name = "New") => call(playersRoute.POST(json("POST", { firstName: name, lastName: "P", position: "MIDFIELDER", rating: "GOOD" }), g(org)));
const newMatch = (org: string, date = "2099-01-05") => call(matchesRoute.POST(json("POST", { date, startTime: "21:00", communityId: `${org}-c` }), g(org)));
const SCHED = (org: string) => ({ communityId: `${org}-c`, timezone: "America/New_York", weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" });

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("MATCH_SHARE_SECRET", "m111-integration-test-secret-0123456789abc");
});
beforeEach(async () => {
  session = null;
  tgCalls = [];
  aiCalls = 0;
  aiMode = "ok";
  otherNetwork = 0;
  await seed();
  await signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ============================================================ TRIAL
describe("M11.1 — introductory trial", () => {
  const ws = (user: string, name: string, now = new Date()) => createOrganizationWorkspace(user, { organizationName: name, groupName: "Mondays", sportKey: "soccer", timezone: "UTC" }, now);

  it("a verified User's first Organization gets 90 days of Pro (UTC, server-computed, audited); the next one starts on Free", async () => {
    const now = new Date("2026-10-09T15:00:00Z");
    const first = await ws("u-newbie", "First Club", now);
    const org1 = await prisma.organization.findUniqueOrThrow({ where: { id: first.organization.id } });
    expect(org1).toMatchObject({ plan: "FREE", trialStartedAt: now, trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS) });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-newbie" } })).trialUsedAt).toEqual(now);
    expect(await prisma.entitlementEvent.findMany({ where: { organizationId: org1.id }, select: { action: true, actor: true } })).toEqual([{ action: "TRIAL_STARTED", actor: "user:u-newbie" }]);
    expect((await planSummary(org1.id, now)).plan).toBe("TRIAL");
    expect((await planSummary(org1.id, new Date(now.getTime() + 91 * DAY_MS))).plan).toBe("FREE"); // expiry → Free, never charged

    const second = await ws("u-newbie", "Second Club", now);
    const org2 = await prisma.organization.findUniqueOrThrow({ where: { id: second.organization.id } });
    expect(org2).toMatchObject({ plan: "FREE", trialStartedAt: null, trialEndsAt: null });
  });

  it("an existing verified owner of a LEGACY Organization (trialUsedAt unset) gets exactly one trial on a new Organization; the LEGACY one is untouched", async () => {
    // u-owner already owns the grandfathered "legacy" Organization (and others) and has never used a trial.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } })).trialUsedAt).toBeNull();
    const first = await ws("u-owner", "Owner New Club");
    const second = await ws("u-owner", "Owner Another Club");
    const [a, b] = await Promise.all([first, second].map((w) => prisma.organization.findUniqueOrThrow({ where: { id: w.organization.id } })));
    expect(a.trialEndsAt).not.toBeNull();
    expect((await planSummary(a.id)).plan).toBe("TRIAL");
    expect(b.trialEndsAt).toBeNull();
    expect((await planSummary(b.id)).plan).toBe("FREE");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } })).trialUsedAt).not.toBeNull();
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: "legacy" } })).toMatchObject({ plan: "LEGACY", trialEndsAt: null });
    expect((await planSummary("legacy")).plan).toBe("LEGACY");
  });

  it("an unverified account gets no trial; concurrent creations by one User yield exactly one trial", async () => {
    const un = await ws("u-unverified", "Unverified Club");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: un.organization.id } })).trialEndsAt).toBeNull();
    const many = await Promise.all(["A", "B", "C", "D"].map((n) => ws("u-newbie", `Club ${n}`)));
    const orgs = await prisma.organization.findMany({ where: { id: { in: many.map((m) => m.organization.id) } } });
    expect(orgs).toHaveLength(4);
    expect(orgs.filter((x) => x.trialEndsAt !== null)).toHaveLength(1);
  });

  it("an expired trial means Free limits; a running trial means Pro limits", async () => {
    expect((await planSummary("free")).usage.activeGroups.limit).toBe(1);
    expect((await planSummary("trial")).usage.activeGroups.limit).toBe(3);
    expect((await planSummary("trial")).trialDaysLeft).toBe(30);
  });
});

// ============================================================ GRANDFATHERING + COMP
describe("M11.1 — existing Organizations and complimentary Pro", () => {
  it("the migration grandfathers every pre-existing Organization as LEGACY (audited) — no limits, Telegram kept", async () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261016120000_m111_plans_entitlements/migration.sql"), "utf8");
    const grandfather = sql.slice(sql.indexOf('UPDATE "Organization" SET "plan" = \'LEGACY\';'));
    expect(grandfather).toMatch(/^UPDATE "Organization" SET "plan" = 'LEGACY';\s+INSERT INTO "EntitlementEvent"/);
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM|TRUNCATE|"trialUsedAt" =/); // ON DELETE CASCADE (FK) is fine
    await prisma.$transaction(async (tx) => {
      for (const stmt of grandfather.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await tx.$executeRawUnsafe(stmt);
    });
    expect(new Set((await prisma.organization.findMany({ select: { plan: true } })).map((x) => x.plan))).toEqual(new Set(["LEGACY"]));
    expect(await prisma.entitlementEvent.count({ where: { action: "GRANDFATHERED", toPlan: "LEGACY" } })).toBe(5);

    // LEGACY keeps everything: more groups, players, matches and schedules than any plan, plus Telegram.
    await addPlayers("legacy", 160);
    for (const n of ["A", "B", "C"]) expect((await call(groupsRoute.POST(json("POST", { groupName: `Extra ${n}`, sportKey: "soccer", timezone: "UTC" }), o("legacy")))).status).toBe(201);
    expect((await newPlayer("legacy")).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await newMatch("legacy", `2099-02-${String(i + 1).padStart(2, "0")}`)).status).toBe(201);
    for (let i = 0; i < 2; i++) expect((await call(schedulesRoute.POST(json("POST", SCHED("legacy")), g("legacy")))).status).toBe(201);
    expect((await call(channelsRoute.POST(json("POST", {}), g("legacy")))).status).toBeLessThan(300);
    expect((await planSummary("legacy")).label).toBe("Early access");
  });

  it("COMP gives Pro limits; changes are explicit, validated and audited", async () => {
    for (const n of ["A", "B"]) expect((await call(groupsRoute.POST(json("POST", { groupName: `C ${n}`, sportKey: "soccer", timezone: "UTC" }), o("comp")))).status).toBe(201);
    expect(await call(groupsRoute.POST(json("POST", { groupName: "C 4", sportKey: "soccer", timezone: "UTC" }), o("comp")))).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "activeGroups", limit: 3 } });

    await expect(changeEntitlement({ organizationId: "free", action: "grant-comp", reason: "", actor: "ops" })).rejects.toThrow(/reason/);
    expect(await changeEntitlement({ organizationId: "free", action: "grant-comp", reason: "Founder org approved", actor: "ops@tbp" })).toMatchObject({ plan: "COMP" });
    expect((await planSummary("free")).plan).toBe("COMP");
    expect(await changeEntitlement({ organizationId: "free", action: "revoke-comp", reason: "Founder period ended", actor: "ops@tbp" })).toMatchObject({ plan: "FREE" });
    const t = await changeEntitlement({ organizationId: "trial", action: "trial", days: 15, reason: "Extension for pilot", actor: "ops@tbp" });
    expect(t.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 44 * DAY_MS); // extended from the current end (30 + 15 days)
    const legacy = await changeEntitlement({ organizationId: "legacy", action: "trial", days: 90, reason: "Legacy → introductory trial", actor: "ops@tbp" });
    expect(legacy).toMatchObject({ plan: "FREE" });
    await prisma.organization.update({ where: { id: "other" }, data: { plan: "PRO" } });
    await expect(changeEntitlement({ organizationId: "other", action: "grant-comp", reason: "should not apply", actor: "ops" })).rejects.toThrow(/paid plan/);
    expect((await prisma.entitlementEvent.findMany({ orderBy: { createdAt: "asc" }, select: { organizationId: true, action: true, fromPlan: true, toPlan: true, actor: true } })).map((e) => `${e.organizationId}:${e.action}:${e.fromPlan}->${e.toPlan}`)).toEqual([
      "free:GRANT_COMP:FREE->COMP",
      "free:REVOKE_COMP:COMP->FREE",
      "trial:TRIAL:FREE->FREE",
      "legacy:TRIAL:LEGACY->FREE",
    ]);
  });
});

// ============================================================ CAPACITY
describe("M11.1 — capacity limits are enforced on the server", () => {
  it("groups: Free 1, trial 3 (402 PLAN_LIMIT with a clear message)", async () => {
    const r = await call(groupsRoute.POST(json("POST", { groupName: "Second", sportKey: "soccer", timezone: "UTC" }), o("free")));
    expect(r).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "activeGroups", limit: 1 } });
    expect(r.body.error).toBe("Your Free plan limit has been reached (1 active group). Pro plans and upgrades are coming soon.");
    expect(await prisma.group.count({ where: { organizationId: "free" } })).toBe(1);
    for (const n of ["A", "B"]) expect((await call(groupsRoute.POST(json("POST", { groupName: n, sportKey: "soccer", timezone: "UTC" }), o("trial")))).status).toBe(201);
    expect((await call(groupsRoute.POST(json("POST", { groupName: "D", sportKey: "soccer", timezone: "UTC" }), o("trial")))).body.error).toBe("Your Pro trial plan limit has been reached (3 active groups).");
  });

  it("players: 30 UNIQUE active per Organization (Community memberships never double count); inactive add is fine; reactivation counts", async () => {
    const ids = await addPlayers("free", 29);
    await prisma.community.create({ data: { id: "free-c2", groupId: "free-g", name: "Second community" } });
    await prisma.communityPlayer.createMany({ data: ids.flatMap((playerId) => [{ groupId: "free-g", communityId: "free-c", playerId }, { groupId: "free-g", communityId: "free-c2", playerId }]) });
    expect((await planSummary("free")).usage.activePlayers).toEqual({ used: 29, limit: 30 });
    expect((await newPlayer("free", "Thirtieth")).status).toBe(200);
    expect(await newPlayer("free", "Thirty-first")).toMatchObject({ status: 402, body: { metric: "activePlayers", limit: 30 } });
    expect((await call(playersRoute.POST(json("POST", { firstName: "Bench", lastName: "P", position: "MIDFIELDER", rating: "GOOD", isActive: false }), g("free")))).status).toBe(200);
    const bench = await prisma.player.findFirstOrThrow({ where: { firstName: "Bench" } });
    expect((await call(playerRoute.PATCH(json("PATCH", { isActive: true }), gp("free", bench.id)))).status).toBe(402);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: bench.id } })).isActive).toBe(false);
    expect((await call(playerRoute.PATCH(json("PATCH", { isActive: false }), gp("free", ids[0])))).status).toBe(200); // deactivating is always allowed
    expect((await call(playerRoute.PATCH(json("PATCH", { isActive: true }), gp("free", bench.id)))).status).toBe(200);
    expect((await call(playerRoute.PATCH(json("PATCH", { firstName: "Renamed" }), gp("free", bench.id)))).status).toBe(200); // editing never counts
  });

  it("concurrent requests cannot pass a limit (Organization lock): 6 parallel adds at 29/30 → exactly 1", async () => {
    await addPlayers("free", 29);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => newPlayer("free", `Racer${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(5);
    expect(await prisma.player.count({ where: { group: { organizationId: "free" }, isActive: true } })).toBe(30);
  });

  it("matches: Free 8 new per UTC month (older months don't count); limits are per Organization", async () => {
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
    await prisma.match.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ id: `old${i}`, groupId: "free-g", date: new Date("2099-03-01"), createdAt: lastMonth })) });
    await prisma.match.createMany({ data: Array.from({ length: 7 }, (_, i) => ({ id: `now${i}`, groupId: "free-g", date: new Date("2099-03-02") })) });
    expect((await newMatch("free")).status).toBe(201);
    expect(await newMatch("free", "2099-01-06")).toMatchObject({ status: 402, body: { metric: "monthlyMatches", limit: 8 } });
    await signIn("other");
    await prisma.match.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ id: `ot${i}`, groupId: "other-g", date: new Date("2099-03-02") })) });
    expect((await planSummary("free")).usage.monthlyMatches.used).toBe(8);
  });

  it("matches: a CANCELED match still counts toward the month; a FAILED creation (validation, plan limit) never does", async () => {
    await prisma.match.createMany({ data: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, groupId: "free-g", date: new Date("2099-03-02") })) });
    const seventh = await newMatch("free", "2099-01-07");
    expect(seventh.status).toBe(201);
    const id = (seventh.body.match as { id: string }).id;
    expect((await call(matchRoute.PATCH(json("PATCH", { status: "CANCELED" }), gm("free", id)))).status).toBe(200);
    expect((await planSummary("free")).usage.monthlyMatches.used).toBe(7); // canceled still counts
    // Failed creations: unknown community (404), invalid body (400) — nothing created, nothing counted.
    expect((await call(matchesRoute.POST(json("POST", { date: "2099-01-08", startTime: "21:00", communityId: "nope" }), g("free")))).status).toBe(404);
    expect((await call(matchesRoute.POST(json("POST", { date: "not-a-date" }), g("free")))).status).toBe(400);
    expect((await planSummary("free")).usage.monthlyMatches.used).toBe(7);
    expect((await newMatch("free", "2099-01-09")).status).toBe(201); // the 8th
    const refused = await newMatch("free", "2099-01-10");
    expect(refused).toMatchObject({ status: 402, body: { error: "Your Free plan limit has been reached (8 new matches per month). Pro plans and upgrades are coming soon." } });
    expect((await planSummary("free")).usage.monthlyMatches.used).toBe(8); // the refused one isn't counted
    expect(await prisma.match.count({ where: { groupId: "free-g" } })).toBe(8);
  });

  it("schedules: Free 1 active; a paused one can be created; resuming a second is refused", async () => {
    expect((await call(schedulesRoute.POST(json("POST", SCHED("free")), g("free")))).status).toBe(201);
    expect(await call(schedulesRoute.POST(json("POST", SCHED("free")), g("free")))).toMatchObject({ status: 402, body: { metric: "activeSchedules", limit: 1 } });
    const paused = await call(schedulesRoute.POST(json("POST", { ...SCHED("free"), isActive: false }), g("free")));
    expect(paused.status).toBe(201);
    const id = (paused.body.schedule as { id: string }).id;
    expect((await call(scheduleRoute.PATCH(json("PATCH", { isActive: true }), gs("free", id)))).status).toBe(402);
    expect((await call(scheduleRoute.PATCH(json("PATCH", { startTime: "20:30" }), gs("free", id)))).status).toBe(200); // editing a paused one is fine
  });

  it("MEMBER and other tenants still get the generic 404 (never a plan message)", async () => {
    await signIn("member");
    expect((await newPlayer("free")).status).toBe(404);
    expect((await call(channelsRoute.POST(json("POST", {}), g("free")))).status).toBe(404);
    await signIn("other");
    expect((await newPlayer("free")).status).toBe(404);
  });
});

// ============================================================ TELEGRAM
describe("M11.1 — Telegram is a Pro capability", () => {
  it("Free: connecting a group and posting a poll are refused (402) without any Telegram call; trial/comp may connect", async () => {
    const m = await prisma.match.create({ data: { groupId: "free-g", communityId: "free-c", date: new Date("2099-04-06") } });
    const chat = await prisma.telegramChat.create({ data: { chatId: -1001n, title: "Old chat", groupId: "free-g", communityId: "free-c" } });
    expect(await call(channelsRoute.POST(json("POST", {}), g("free")))).toMatchObject({
      status: 402,
      body: { code: "PLAN_LIMIT", metric: "telegram", error: "Your Free plan limit has been reached (Telegram integration is part of Pro; players use the match link). Pro plans and upgrades are coming soon." },
    });
    expect((await call(pollRoute.POST(json("POST", { chatRef: chat.id, intent: "post" }), gm("free", m.id)))).status).toBe(402);
    expect(tgCalls).toEqual([]);
    for (const org of ["trial", "comp"]) expect((await call(channelsRoute.POST(json("POST", {}), g(org)))).status, org).toBeLessThan(300);
    // The existing connection is kept (never deleted).
    expect(await prisma.telegramChat.count({ where: { groupId: "free-g" } })).toBe(1);
  });
});

// ============================================================ AUTOMATION + DOWNGRADE
describe("M11.1 — automation respects the plan", () => {
  const afterPoll = new Date("2026-10-12T00:05:00Z"); // Sunday 20:05 New York; game Monday Oct 12

  it("automatic matches count toward the monthly limit: at the limit nothing is created, nothing is sent, no error", async () => {
    await prisma.match.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, groupId: "free-g", date: new Date("2099-03-02"), createdAt: afterPoll })) });
    await prisma.matchSchedule.create({ data: { groupId: "free-g", ...SCHED("free") } });
    expect(await runMatchAutomation(afterPoll)).toMatchObject({ created: 0, limited: 1, errors: [] });
    expect(await prisma.match.count({ where: { scheduleId: { not: null } } })).toBe(0);
    expect(tgCalls).toEqual([]);
  });

  it("Free with a connected Telegram group: automation uses the match link (no Telegram call)", async () => {
    await prisma.telegramChat.create({ data: { chatId: -1002n, title: "Old chat", groupId: "free-g", communityId: "free-c" } });
    await prisma.matchSchedule.create({ data: { groupId: "free-g", ...SCHED("free") } });
    expect(await runMatchAutomation(afterPoll)).toMatchObject({ created: 1, pollsPosted: 0, errors: [] });
    expect(tgCalls).toEqual([]);
    expect((await prisma.matchAutomation.findFirstOrThrow()).pollPostedAt).not.toBeNull();
  });

  it("downgrade with 2 active schedules: automation pauses (nothing chosen silently, nothing deleted); Run now is blocked; the organizer keeps one and it resumes", async () => {
    const s1 = await prisma.matchSchedule.create({ data: { groupId: "free-g", ...SCHED("free") } });
    const s2 = await prisma.matchSchedule.create({ data: { groupId: "free-g", ...SCHED("free"), startTime: "20:45", pollTime: "19:00", cutoffTime: "19:30" } });
    const list = await call(schedulesRoute.GET(json("GET"), g("free")));
    expect(list.body.planLimit).toEqual({ over: true, active: 2, limit: 1 });
    expect(await runMatchAutomation(afterPoll)).toMatchObject({ created: 0, paused: 2, errors: [] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(afterPoll);
    try {
      const blocked = await call(scheduleRunRoute.POST(json("POST"), gs("free", s1.id)));
      expect(blocked.body).toMatchObject({ ok: false, created: 0 });
      expect(String((blocked.body.issues as string[])[0])).toMatch(/Choose the schedule to keep active/);
    } finally {
      vi.useRealTimers();
    }
    expect(await prisma.match.count()).toBe(0);
    expect(await prisma.matchSchedule.count({ where: { isActive: true } })).toBe(2); // nothing paused or deleted automatically

    await signIn("member");
    expect((await call(keepRoute.POST(json("POST"), gs("free", s2.id)))).status).toBe(404);
    await signIn("other");
    expect((await call(keepRoute.POST(json("POST"), gs("free", s2.id)))).status).toBe(404);
    await signIn("owner");
    expect((await call(keepRoute.POST(json("POST"), gs("free", s2.id)))).body).toEqual({ ok: true, paused: 1 });
    expect(await prisma.matchSchedule.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, isActive: true } })).toEqual([
      { id: s1.id, isActive: false },
      { id: s2.id, isActive: true },
    ]);
    expect(await runMatchAutomation(afterPoll)).toMatchObject({ created: 1, paused: 0 });
  });

  it("an expired trial never deletes or deactivates anything", async () => {
    await addPlayers("trial", 40);
    for (const n of ["A", "B"]) await call(groupsRoute.POST(json("POST", { groupName: n, sportKey: "soccer", timezone: "UTC" }), o("trial")));
    const before = { groups: await prisma.group.count({ where: { organizationId: "trial", isActive: true } }), players: await prisma.player.count({ where: { isActive: true, group: { organizationId: "trial" } } }) };
    await prisma.organization.update({ where: { id: "trial" }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const after = await planSummary("trial");
    expect(after.plan).toBe("FREE");
    expect(after.usage.activeGroups).toEqual({ used: before.groups, limit: 1 });
    expect(after.usage.activePlayers).toEqual({ used: before.players, limit: 30 });
    expect((await call(playersRoute.GET(json("GET"), g("trial")))).status).toBe(200); // still readable
    expect((await newPlayer("trial")).status).toBe(402); // only capacity increases are blocked
  });
});

// ============================================================ AI RECAP CREDITS + DETERMINISTIC GENERATION
describe("M11.1 — AI recap credits and unlimited team generation", () => {
  async function publishedMatch(org: string) {
    await addPlayers(org, 4);
    const m = await prisma.match.create({ data: { groupId: `${org}-g`, date: new Date("2099-05-04") } });
    const gen = await call(generateRoute.POST(json("POST", { teamCount: 2, date: "2099-05-04", selectedIds: [0, 1, 2, 3].map((i) => `${org}-p${i}`), matchId: m.id }), g(org)));
    await call(publishRoute.POST(json("POST", { date: "2099-05-04", teams: gen.body.teams, matchId: m.id }), g(org)));
    const pg = (b: unknown) => call(postGameRoute.POST(json("POST", b), gm(org, m.id)));
    await pg({ action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 }] });
    await pg({ action: "publish_result" });
    return { matchId: m.id, pg };
  }

  it("Free: 2 successful generations per month (regeneration counts too); failures cost nothing; the 3rd is refused with the standard recap", async () => {
    const { pg } = await publishedMatch("free");
    aiMode = "500";
    expect((await pg({ action: "generate_recap" })).status).toBe(503);
    expect(await aiCreditsUsed("free")).toBe(0);
    aiMode = "ok";
    const first = await pg({ action: "generate_recap" });
    expect(first.body).toMatchObject({ ok: true, aiUsage: { used: 1, limit: 2 } });
    expect((await pg({ action: "generate_recap" })).body).toMatchObject({ ok: true, aiUsage: { used: 2, limit: 2 } }); // a regeneration costs one
    const third = await pg({ action: "generate_recap" });
    expect(third).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "monthlyAiRecaps", limit: 2 } });
    expect(String(third.body.error)).toMatch(/^Your Free plan limit has been reached \(2 AI recaps per month\)\. Pro plans and upgrades are coming soon\. Write or edit the recap yourself — AI recaps reset /);
    expect(third.body.fallback).toEqual(expect.any(String));
    expect(aiCalls).toBe(3); // the refused request never reached OpenAI
    // Save / publish / view cost nothing.
    expect((await pg({ action: "save_recap", content: "Edited by hand" })).status).toBe(200);
    expect((await pg({ action: "publish_recap" })).status).toBe(200);
    expect(await aiCreditsUsed("free")).toBe(2);
    const v = await call(matchRoute.GET(json("GET"), gm("free", (await prisma.match.findFirstOrThrow({ where: { groupId: "free-g" } })).id)));
    expect((v.body.postGame as { aiUsage: unknown }).aiUsage).toMatchObject({ used: 2, limit: 2 });
  });

  it("concurrency: 5 parallel generations with 2 credits left → exactly 2 succeed", async () => {
    const { pg } = await publishedMatch("free");
    const results = await Promise.all(Array.from({ length: 5 }, () => pg({ action: "generate_recap" })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    expect(await aiCreditsUsed("free")).toBe(2);
  });

  it("crash recovery: an abandoned reservation expires and is released (never charged); settling twice is a no-op", async () => {
    const t0 = new Date("2026-10-09T12:00:00Z");
    const a = await reserveAiCredit({ organizationId: "free", groupId: "free-g", matchId: "x", userId: null }, t0);
    const b = await reserveAiCredit({ organizationId: "free", groupId: "free-g", matchId: "x", userId: null }, t0);
    await expect(reserveAiCredit({ organizationId: "free", groupId: "free-g", matchId: "x", userId: null }, t0)).rejects.toThrow(/AI recaps/);
    // "a" crashed (never settled). Three minutes later it no longer counts and is released on the next reservation.
    await settleAiCredit(b, true, t0);
    await settleAiCredit(b, false, t0); // no-op: already settled
    const later = new Date(t0.getTime() + 3 * 60_000);
    expect(await aiCreditsUsed("free", later)).toBe(1);
    await reserveAiCredit({ organizationId: "free", groupId: "free-g", matchId: "x", userId: null }, later);
    expect((await prisma.aiUsage.findUniqueOrThrow({ where: { id: a } })).status).toBe("RELEASED");
    expect((await prisma.aiUsage.findUniqueOrThrow({ where: { id: b } })).status).toBe("SUCCEEDED");
  });

  it("trial / comp get 30 per month; LEGACY has no monthly limit (still metered)", async () => {
    expect((await planSummary("trial")).usage.monthlyAiRecaps.limit).toBe(30);
    expect((await planSummary("comp")).usage.monthlyAiRecaps.limit).toBe(30);
    expect((await planSummary("legacy")).usage.monthlyAiRecaps.limit).toBeNull();
  });

  it("deterministic team generation is unlimited on Free and never calls OpenAI", async () => {
    await addPlayers("free", 10);
    for (let i = 0; i < 25; i++) {
      const r = await call(generateRoute.POST(json("POST", { teamCount: 2, date: "2099-06-01", selectedIds: Array.from({ length: 10 }, (_, k) => `free-p${k}`) }), g("free")));
      expect(r.status).toBe(200);
    }
    expect(aiCalls).toBe(0);
    expect(otherNetwork).toBe(0);
  });
});
