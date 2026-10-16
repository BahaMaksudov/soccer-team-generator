/**
 * M11.3 — 90-day Pro trial lifecycle, Telegram after expiry, password recovery.
 * REAL DATABASE (guarded local test DB only). Telegram is FAKE (every Bot API
 * call is captured); email goes to the in-memory test outbox; nothing leaves
 * the machine.
 *
 * Organizations: "expired" (trial ended yesterday), "trial" (30 days left),
 * "legacy" (LEGACY), "comp" (COMP) — all owned by u-owner, so one User owning
 * several Organizations is covered throughout.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// after(): queued here and run explicitly, as the platform does after the response.
const afterQueue: Array<() => Promise<void> | void> = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<void> | void) => void afterQueue.push(fn) }));
// Rate limits: Upstash isn't configured in tests; the routes' use of the buckets is asserted through this spy.
const rateLimitCalls: Array<{ bucket: string; key: string }> = [];
let rateLimitDeny: string | null = null;
vi.mock("@/lib/rateLimit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rateLimit")>()),
  checkRateLimit: vi.fn(async (bucket: string, key: string) => {
    rateLimitCalls.push({ bucket, key });
    return { allowed: bucket !== rateLimitDeny };
  }),
}));

import { prisma } from "@/lib/prisma";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as pollCloseRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close/route";
import * as closeNoticeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close-notice/route";
import * as channelsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/route";
import * as forgotRoute from "@/app/api/password/forgot/route";
import * as resetRoute from "@/app/api/password/reset/route";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { assertTelegram, effectivePlan, organizationPlan, TRIAL_DAYS } from "@/lib/entitlements";
import { runTrialLifecycle, MAX_ATTEMPTS, STALE_CLAIM_MS } from "@/lib/trialLifecycle";
import { redeemTelegramBindCode, bindReplyText } from "@/lib/telegramChannels";
import { getPasswordResetPreview, resetPassword, PASSWORD_RESET_TTL_MS, FORGOT_PASSWORD_MESSAGE } from "@/lib/passwordReset";
import { authenticateCredentials, hashPassword } from "@/lib/accounts";
import { hashToken } from "@/lib/secureToken";
import { authOptions } from "@/lib/authOptions";
import { testOutbox } from "@/lib/email/transport";
import { zonedToUtc } from "@/lib/scheduleTime";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const H = 3_600_000;
const TZ = "America/New_York";

// ------------------------------------------------------------ fake Telegram
let tg: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let seq = 500;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: { body?: string }): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tg.push({ method, body: JSON.parse(init?.body ?? "{}") });
  if (method === "getChatAdministrators") return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ status: "creator", user: { id: 4242 } }] }) } as unknown as Response;
  if (method === "stopPoll") return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: "x", is_closed: true } }) } as unknown as Response;
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++seq, poll: { id: `tp${seq}` } } }) } as unknown as Response;
}
const tgMethods = () => tg.map((c) => c.method);

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const g = (org: string) => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: `${org}-g` }) });
const gm = (org: string, matchId: string) => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: `${org}-g`, matchId }) });
const runAfter = async () => {
  while (afterQueue.length) await afterQueue.shift()!();
};

const ORGS = ["expired", "trial", "legacy", "comp"] as const;
type OrgId = (typeof ORGS)[number];
let NOW: Date; // the real clock at seed time (route handlers use the real clock)
const PLANS = (now: Date): Record<OrgId, { plan: "FREE" | "LEGACY" | "COMP"; trialStartedAt: Date | null; trialEndsAt: Date | null }> => ({
  expired: { plan: "FREE", trialStartedAt: new Date(now.getTime() - (TRIAL_DAYS + 1) * DAY), trialEndsAt: new Date(now.getTime() - DAY) },
  trial: { plan: "FREE", trialStartedAt: new Date(now.getTime() - 60 * DAY), trialEndsAt: new Date(now.getTime() + 30 * DAY) },
  legacy: { plan: "LEGACY", trialStartedAt: null, trialEndsAt: null },
  comp: { plan: "COMP", trialStartedAt: null, trialEndsAt: null },
});
const CHAT = (org: OrgId) => BigInt(-1000 - ORGS.indexOf(org));

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TrialNotice","PasswordResetToken","EntitlementEvent","MatchAutomationEmail","MatchAutomation","MatchSchedule","MessageDelivery","AttendanceResponse","TeamGeneration","Match","CommunityPlayer","Community","TelegramChatPlayer","TelegramChatBindCode","TelegramPollAnswer","TelegramPoll","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  NOW = new Date();
  const pw = await hashPassword("old-password-123");
  await prisma.user.createMany({
    data: [
      { id: "u-owner", email: "owner@example.test", name: "Owner", passwordHash: pw, emailVerifiedAt: VERIFIED },
      { id: "u-coowner", email: "coowner@example.test", name: "Co-owner", passwordHash: pw, emailVerifiedAt: VERIFIED },
      { id: "u-admin", email: "admin@example.test", name: "Admin", passwordHash: pw, emailVerifiedAt: VERIFIED },
      { id: "u-google", email: "google@example.test", name: "Google", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-beta", email: "beta@example.test", name: "Beta", passwordHash: pw, emailVerifiedAt: VERIFIED },
      { id: "u-regular", email: "regular@example.test", name: "Regular", passwordHash: pw, emailVerifiedAt: VERIFIED },
    ],
  });
  for (const org of ORGS) {
    await prisma.organization.create({ data: { id: org, name: `Org ${org}`, slug: org, ...PLANS(NOW)[org] } });
    await prisma.group.create({ data: { id: `${org}-g`, organizationId: org, name: `${org} group`, slug: `${org}-g`, sportKey: "soccer", timezone: TZ } });
    await prisma.community.create({ data: { id: `${org}-c`, groupId: `${org}-g`, name: `${org} players` } });
    const chat = await prisma.telegramChat.create({ data: { chatId: CHAT(org), title: `${org} chat`, groupId: `${org}-g`, communityId: `${org}-c` } });
    await prisma.player.createMany({ data: [1, 2, 3].map((i) => ({ id: `${org}-p${i}`, groupId: `${org}-g`, firstName: `P${i}`, lastName: org, position: "MIDFIELDER" as const, rating: "GOOD" as const, stamina: 3 })) });
    // An upcoming match whose attendance poll was posted during the trial (still open).
    await prisma.match.create({ data: { id: `${org}-m`, groupId: `${org}-g`, date: new Date("2099-06-03T00:00:00Z"), startTime: "21:00", communityId: `${org}-c`, telegramChatId: chat.id } });
    await prisma.telegramPoll.create({ data: { pollId: `poll-${org}`, chatId: CHAT(org), messageId: 77n, question: "Who is playing?", optionsJson: "[]", groupId: `${org}-g`, matchId: `${org}-m`, kind: "ATTENDANCE" } });
    await prisma.messageDelivery.create({ data: { groupId: `${org}-g`, matchId: `${org}-m`, eventType: "ATTENDANCE_POLL_POSTED", channel: "TELEGRAM", destination: CHAT(org).toString(), telegramPollId: `poll-${org}`, contentHash: "h", status: "SENT", claimedAt: VERIFIED, sentAt: VERIFIED } });
    await prisma.attendanceResponse.create({ data: { matchId: `${org}-m`, groupId: `${org}-g`, playerId: `${org}-p1`, participantStatus: "PLAYING", participantSource: "TELEGRAM", participantRespondedAt: VERIFIED } });
    await prisma.organizationMembership.createMany({
      data: [
        { userId: "u-owner", organizationId: org, role: "OWNER" },
        { userId: "u-admin", organizationId: org, role: "ADMIN" },
      ],
    });
  }
  await prisma.organizationMembership.create({ data: { userId: "u-coowner", organizationId: "expired", role: "OWNER" } });
}

const counts = async () => ({
  players: await prisma.player.count(),
  communities: await prisma.community.count(),
  matches: await prisma.match.count(),
  attendance: await prisma.attendanceResponse.count(),
  polls: await prisma.telegramPoll.count(),
  deliveries: await prisma.messageDelivery.count(),
  chats: await prisma.telegramChat.count({ where: { disconnectedAt: null } }),
});

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("MATCH_SHARE_SECRET", "m113-integration-test-secret-0123456789abc");
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("SUPPORT_EMAIL", "");
  vi.stubEnv("TRIAL_LIFECYCLE", "");
});
beforeEach(async () => {
  session = null;
  tg = [];
  otherNetwork = 0;
  afterQueue.length = 0;
  rateLimitCalls.length = 0;
  rateLimitDeny = null;
  testOutbox.clear();
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ============================================================ PART B — trial lifecycle
describe("M11.3 — the 90-day trial", () => {
  const ws = (user: string, name: string, now: Date) => createOrganizationWorkspace(user, { organizationName: name, groupName: "Mondays", sportKey: "soccer", timezone: "UTC" }, now);

  it("starts when the Organization is created; 'beta' and regular customers get exactly the same 90 days; a retried creation never extends it", async () => {
    const now = new Date(); // the replay window is checked against the row's real createdAt
    const beta = await ws("u-beta", "Beta Club", now);
    const regular = await ws("u-regular", "Regular Club", new Date(now.getTime() + 5 * H));
    const b = await prisma.organization.findUniqueOrThrow({ where: { id: beta.organization.id } });
    const r = await prisma.organization.findUniqueOrThrow({ where: { id: regular.organization.id } });
    expect(b.trialEndsAt!.getTime() - b.trialStartedAt!.getTime()).toBe(TRIAL_DAYS * DAY);
    expect(r.trialEndsAt!.getTime() - r.trialStartedAt!.getTime()).toBe(TRIAL_DAYS * DAY);
    expect(b.trialStartedAt).toEqual(now); // the creation instant, not signup
    // A double-submitted / retried creation replays the same workspace: no new Organization, no extension.
    const replay = await ws("u-beta", "Beta Club", new Date(now.getTime() + 60_000));
    expect(replay).toMatchObject({ replayed: true, organization: { id: b.id } });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.id } })).trialEndsAt).toEqual(b.trialEndsAt);
    expect(await prisma.entitlementEvent.count({ where: { organizationId: b.id, action: "TRIAL_STARTED" } })).toBe(1);
  });

  it("day 89 → Pro trial (Telegram on); the exact end instant → Free (Telegram off) — computed per request, no job needed", async () => {
    const now = new Date("2026-11-02T10:30:00Z");
    const { organization } = await ws("u-beta", "Boundary Club", now);
    const end = new Date(now.getTime() + TRIAL_DAYS * DAY);
    expect((await organizationPlan(organization.id, new Date(now.getTime() + 89 * DAY))).plan).toBe("TRIAL");
    expect((await organizationPlan(organization.id, new Date(end.getTime() - 1))).plan).toBe("TRIAL");
    await expect(assertTelegram(organization.id, new Date(end.getTime() - 1))).resolves.toBeUndefined();
    expect((await organizationPlan(organization.id, end)).plan).toBe("FREE");
    await expect(assertTelegram(organization.id, end)).rejects.toThrow(/Pro trial ended on Jan 31, 2027/);
    // Stored plan is untouched (FREE + trialEndsAt): nothing to migrate or "downgrade" in the database.
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { plan: true, trialEndsAt: true } })).toEqual({ plan: "FREE", trialEndsAt: end });
  });

  it("LEGACY and COMP keep their entitlement: no trial, Telegram on, never touched by the lifecycle job", async () => {
    vi.stubEnv("TRIAL_LIFECYCLE", "send");
    const before = await prisma.organization.findMany({ where: { id: { in: ["legacy", "comp"] } }, orderBy: { id: "asc" } });
    await runTrialLifecycle(new Date(NOW.getTime() + 400 * DAY));
    await runTrialLifecycle(NOW);
    expect(await prisma.organization.findMany({ where: { id: { in: ["legacy", "comp"] } }, orderBy: { id: "asc" } })).toEqual(before);
    for (const org of ["legacy", "comp"]) {
      await expect(assertTelegram(org)).resolves.toBeUndefined();
      expect(await prisma.entitlementEvent.count({ where: { organizationId: org } })).toBe(0);
      expect(await prisma.trialNotice.count({ where: { organizationId: org } })).toBe(0);
    }
    vi.stubEnv("TRIAL_LIFECYCLE", "");
  });
});

// ============================================================ PART C — Telegram after expiry
describe("M11.3 — Telegram after the trial ended", () => {
  it("every organizer Telegram action is refused with an understandable 402 (never a generic error) and NOTHING is sent", async () => {
    const msg = /^Telegram integration is part of Pro\. This organization's Pro trial ended on .+, so it is now on the Free plan\. .*kept\. Pro plans and upgrades are coming soon\.$/;
    const post = await call(pollRoute.POST(json("POST", { intent: "post" }), gm("expired", "expired-m")));
    expect(post).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "telegram" } });
    expect(String(post.body.error)).toMatch(msg);
    const close = await call(pollCloseRoute.POST(json("POST"), gm("expired", "expired-m")));
    expect(close).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "telegram" } });
    expect(await call(closeNoticeRoute.POST(json("POST", { action: "retry", deliveryId: "d1" }), gm("expired", "expired-m")))).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT" } });
    expect(await call(channelsRoute.POST(json("POST", {}), g("expired")))).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT" } });
    expect(tg).toEqual([]);
    // The poll posted during the trial stays as it is (no silent close by an organizer action).
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-expired" } })).isClosed).toBe(false);
  });

  it("record-keeping stays available: marking an unclear notice as sent is not a Telegram send (passes the plan check)", async () => {
    const r = await call(closeNoticeRoute.POST(json("POST", { action: "mark_sent", deliveryId: "nope" }), gm("expired", "expired-m")));
    expect(r.status).toBe(404); // past the plan check: the (unknown) notice simply isn't found
    expect(tg).toEqual([]);
  });

  it("one User, several Organizations: the expired one is refused while the trial / LEGACY / COMP ones keep working", async () => {
    expect((await call(pollCloseRoute.POST(json("POST"), gm("expired", "expired-m")))).status).toBe(402);
    for (const org of ["trial", "legacy", "comp"] as const) {
      const r = await call(pollCloseRoute.POST(json("POST"), gm(org, `${org}-m`)));
      expect(r.status, org).toBe(200);
    }
    expect(tgMethods().filter((m) => m === "stopPoll")).toHaveLength(3);
    expect(tg.some((c) => c.body.chat_id === CHAT("expired").toString())).toBe(false);
  });

  it("a connect code issued during the trial can't connect a Telegram group after it ended (code stays unused; clear bot reply)", async () => {
    // Issued while still on trial…
    await prisma.organization.update({ where: { id: "expired" }, data: { trialEndsAt: new Date(Date.now() + DAY) } });
    const issued = await call(channelsRoute.POST(json("POST", {}), g("expired")));
    expect(issued.status).toBe(201);
    const code = String(issued.body.code ?? "");
    expect(code).not.toBe("");
    // …the trial ends before it is redeemed.
    await prisma.organization.update({ where: { id: "expired" }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const r = await redeemTelegramBindCode({ code, chat: { id: -999, type: "supergroup", title: "New" }, fromId: 4242 });
    expect(r).toEqual({ ok: false, code: "NOT_IN_PLAN" });
    expect(bindReplyText(r)).toMatch(/part of Pro/);
    expect(await prisma.telegramChat.count({ where: { chatId: -999n } })).toBe(0);
    expect(await prisma.telegramChatBindCode.count({ where: { usedAt: { not: null } } })).toBe(0);
  });

  it("automation never bypasses the plan: no Game Day Update for an expired Organization; an already-posted poll still closes at its deadline (stopPoll only — no new message)", async () => {
    // Game Day Updates enabled for every group; each match has an open poll and a deadline 2 h ahead.
    for (const org of ORGS) {
      await prisma.groupSetting.create({ data: { groupId: `${org}-g`, key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: false, units: "imperial" }) } });
    }
    const date = "2099-06-03";
    const deadline = zonedToUtc(date, "17:00", TZ);
    await prisma.match.updateMany({ data: { attendanceDeadlineAt: deadline } });
    await prisma.telegramPoll.updateMany({ data: { createdAt: new Date(deadline.getTime() - 24 * H) } });
    const gameDayAt = new Date(deadline.getTime() - 2 * H);
    // Fix the "trial ended" relative to the automation instant.
    await prisma.organization.update({ where: { id: "expired" }, data: { trialEndsAt: new Date(gameDayAt.getTime() - DAY) } });
    await prisma.organization.update({ where: { id: "trial" }, data: { trialEndsAt: new Date(gameDayAt.getTime() + 30 * DAY) } });

    await runMatchAutomation(gameDayAt, { groupId: "expired-g" });
    expect(tg).toEqual([]);
    expect(await prisma.messageDelivery.count({ where: { groupId: "expired-g", eventType: "GAME_DAY_UPDATE_POSTED" } })).toBe(0);
    // The entitled organization (trial) does get its Game Day Update — the workflow still works.
    await runMatchAutomation(gameDayAt, { groupId: "trial-g" });
    expect(tgMethods()).toContain("sendMessage");

    // Deadline passes: the expired org's ALREADY-POSTED poll is closed (not left unmanaged), without any message.
    tg = [];
    await runMatchAutomation(new Date(deadline.getTime() + 60_000), { groupId: "expired-g" });
    expect(tgMethods()).toEqual(["stopPoll"]);
    expect(await prisma.match.findUniqueOrThrow({ where: { id: "expired-m" }, select: { attendanceClosedAt: true } })).toMatchObject({ attendanceClosedAt: expect.any(Date) });
    expect(await prisma.messageDelivery.count({ where: { groupId: "expired-g", eventType: "POLL_CLOSED_NOTICE" } })).toBe(0);
  });

  it("downgrade deletes nothing: players, communities, matches, attendance, polls, deliveries and Telegram connections all survive", async () => {
    vi.stubEnv("TRIAL_LIFECYCLE", "send");
    const before = await counts();
    await runTrialLifecycle(NOW);
    await call(pollRoute.POST(json("POST", { intent: "post" }), gm("expired", "expired-m")));
    await call(pollCloseRoute.POST(json("POST"), gm("expired", "expired-m")));
    expect(await counts()).toEqual(before);
    expect(await prisma.telegramChat.findFirstOrThrow({ where: { groupId: "expired-g" } })).toMatchObject({ disconnectedAt: null, communityId: "expired-c" });
    vi.stubEnv("TRIAL_LIFECYCLE", "");
  });
});

// ============================================================ PART D — reminders + expiry job
describe("M11.3 — trial reminder and expiry emails", () => {
  const ending = async (org: OrgId, msLeft: number, at: Date) => prisma.organization.update({ where: { id: org }, data: { trialEndsAt: new Date(at.getTime() + msLeft) } });
  const emails = () => testOutbox.sent.map((m) => ({ to: m.to, subject: m.subject }));

  it("OFF by default: nothing is recorded or sent", async () => {
    const run = await runTrialLifecycle(NOW);
    expect(run).toMatchObject({ mode: "off", organizations: 0, emailsSent: 0, expiredRecorded: 0 });
    expect(await prisma.entitlementEvent.count()).toBe(0);
    expect(testOutbox.sent).toEqual([]);
  });

  it("audit mode: records TRIAL_EXPIRED once and counts what WOULD be sent — never emails", async () => {
    const r1 = await runTrialLifecycle(NOW, { mode: "audit" });
    const r2 = await runTrialLifecycle(NOW, { mode: "audit" });
    expect(r1).toMatchObject({ expiredRecorded: 1, emailsSent: 0, wouldSend: 2 }); // expired: two verified owners
    expect(r2).toMatchObject({ expiredRecorded: 0, wouldSend: 2 });
    expect(await prisma.entitlementEvent.findMany({ where: { action: "TRIAL_EXPIRED" }, select: { organizationId: true, actor: true } })).toEqual([{ organizationId: "expired", actor: "system:trial-lifecycle" }]);
    expect(testOutbox.sent).toEqual([]);
    expect(await prisma.trialNotice.count()).toBe(0);
  });

  it("14 / 7 / 3 / 1 days and expiry: each stage once per owner, even with repeated and concurrent runs", async () => {
    const t0 = new Date("2027-03-01T12:00:00Z");
    await prisma.organization.update({ where: { id: "expired" }, data: { trialEndsAt: null } }); // only "trial" is relevant here
    await ending("trial", 20 * DAY, t0);
    expect((await runTrialLifecycle(t0, { mode: "send" })).emailsSent).toBe(0); // 20 days left: nothing yet
    const end = new Date(t0.getTime() + 20 * DAY);
    const subjects: string[] = [];
    for (const [stageAt, expect1] of [
      [new Date(end.getTime() - 14 * DAY), /ends in 14 days/],
      [new Date(end.getTime() - 7 * DAY + 3 * H), /ends in 7 days/],
      [new Date(end.getTime() - 3 * DAY), /ends in 3 days/],
      [new Date(end.getTime() - 20 * H), /ends within a day/],
      [new Date(end.getTime() + 2 * H), /has ended/],
    ] as const) {
      testOutbox.clear();
      const runs = await Promise.all([runTrialLifecycle(stageAt, { mode: "send" }), runTrialLifecycle(stageAt, { mode: "send" }), runTrialLifecycle(stageAt, { mode: "send" })]);
      await runTrialLifecycle(new Date(stageAt.getTime() + 15 * 60_000), { mode: "send" }); // the next cron tick
      expect(runs.reduce((n, r) => n + r.emailsSent, 0)).toBe(1);
      expect(emails()).toEqual([{ to: "owner@example.test", subject: expect.stringMatching(expect1) }]);
      subjects.push(testOutbox.sent[0].subject);
    }
    expect(await prisma.trialNotice.findMany({ where: { organizationId: "trial" }, select: { stage: true, status: true }, orderBy: { claimedAt: "asc" } })).toEqual(
      ["D14", "D7", "D3", "D1", "EXPIRED"].map((stage) => ({ stage, status: "SENT" }))
    );
    expect(await prisma.entitlementEvent.count({ where: { organizationId: "trial", action: "TRIAL_EXPIRED" } })).toBe(1);
    // Content: facts, nothing deleted, no payment link while billing is off.
    const last = testOutbox.sent[0];
    expect(last.text).toMatch(/Nothing is deleted/);
    expect(last.text).toMatch(/Pro plans and upgrades are coming soon\./);
    expect(last.text).not.toMatch(/billing|checkout|stripe|pay now/i);
    expect(last.idempotencyKey).toMatch(/^trial-notice\//);
  });

  it("a late run sends only the CURRENT stage (no burst of missed reminders); an expiry long past sends nothing", async () => {
    await ending("trial", 2 * DAY, NOW); // 2 days left: D3 is due; D14 / D7 were missed
    const r = await runTrialLifecycle(NOW, { mode: "send" });
    expect(emails().filter((m) => m.subject.endsWith("Org trial"))).toEqual([{ to: "owner@example.test", subject: "Your Pro trial ends in 2 days — Org trial" }]);
    expect(await prisma.trialNotice.findMany({ where: { organizationId: "trial" }, select: { stage: true } })).toEqual([{ stage: "D3" }]);
    expect(r.emailsSent).toBe(1 + 2); // + the "expired" org (yesterday): its two owners get the expiry email
    testOutbox.clear();
    await prisma.organization.update({ where: { id: "expired" }, data: { trialEndsAt: new Date(NOW.getTime() - 30 * DAY) } });
    await prisma.trialNotice.deleteMany({ where: { organizationId: "expired" } });
    await runTrialLifecycle(NOW, { mode: "send" });
    expect(testOutbox.sent.filter((m) => /has ended/.test(m.subject))).toEqual([]); // outside the 7-day window
  });

  it("partial failure + retry: a refused email is retried on the next run (same idempotency key), others aren't re-sent; attempts are capped", async () => {
    testOutbox.failNext = 1; // the first of the two owners of "expired"
    const r1 = await runTrialLifecycle(NOW, { mode: "send" });
    expect(r1).toMatchObject({ emailsSent: 1, emailsFailed: 1 });
    const failed = await prisma.trialNotice.findFirstOrThrow({ where: { status: "FAILED" } });
    testOutbox.clear();
    const r2 = await runTrialLifecycle(new Date(NOW.getTime() + 15 * 60_000), { mode: "send" });
    expect(r2).toMatchObject({ emailsSent: 1, emailsFailed: 0 });
    expect(testOutbox.sent).toHaveLength(1);
    expect(testOutbox.sent[0].idempotencyKey).toBe(`trial-notice/${failed.id}`);
    expect(await prisma.trialNotice.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "SENT", attempts: 2 });

    // Cap: a notice that keeps failing stops after MAX_ATTEMPTS.
    await prisma.trialNotice.update({ where: { id: failed.id }, data: { status: "FAILED", attempts: MAX_ATTEMPTS } });
    testOutbox.clear();
    await runTrialLifecycle(new Date(NOW.getTime() + 30 * 60_000), { mode: "send" });
    expect(testOutbox.sent).toEqual([]);
  });

  it("an interrupted send (stale SENDING claim) is retried once it is stale — never while another run may still be sending", async () => {
    const key = { organizationId: "expired", userId: "u-owner", stage: "EXPIRED", trialEndsAt: (await prisma.organization.findUniqueOrThrow({ where: { id: "expired" } })).trialEndsAt! };
    await prisma.trialNotice.create({ data: { ...key, status: "SENDING", claimedAt: NOW } });
    await runTrialLifecycle(new Date(NOW.getTime() + 60_000), { mode: "send" });
    expect(testOutbox.sent.map((m) => m.to)).toEqual(["coowner@example.test"]); // owner's claim is fresh: skipped
    testOutbox.clear();
    await runTrialLifecycle(new Date(NOW.getTime() + STALE_CLAIM_MS + 1), { mode: "send" });
    expect(testOutbox.sent.map((m) => m.to)).toEqual(["owner@example.test"]);
  });

  it("skips Organizations with an entitling subscription and only emails verified OWNERs (never ADMINs)", async () => {
    await prisma.billingSubscription.create({ data: { organizationId: "expired", stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x", status: "active", livemode: false, lastSyncedAt: NOW } });
    await ending("trial", 1 * H, NOW);
    await runTrialLifecycle(NOW, { mode: "send" });
    expect(testOutbox.sent.map((m) => m.to)).toEqual(["owner@example.test"]); // trial org only; admin never
  });

  it("a trial extension (new end) starts a new reminder series; the old one is not reused", async () => {
    await ending("trial", 2 * DAY, NOW);
    await runTrialLifecycle(NOW, { mode: "send" });
    await ending("trial", 2 * DAY + 10 * DAY, NOW); // operator extended by 10 days
    testOutbox.clear();
    await runTrialLifecycle(NOW, { mode: "send" });
    expect(testOutbox.sent.filter((m) => m.subject.includes("Org trial")).map((m) => m.subject)).toEqual([expect.stringMatching(/ends in 12 days/)]);
  });
});

// ============================================================ PART E — password recovery
describe("M11.3 — password recovery", () => {
  const forgot = async (email: string) => {
    const r = await call(forgotRoute.POST(json("POST", { email })));
    await runAfter();
    return r;
  };
  const tokenFromEmail = () => {
    const m = testOutbox.sent.at(-1)!.text.match(/\/reset-password\/([A-Za-z0-9_-]{43})/);
    return m![1];
  };
  const reset = (token: string, pw = "brand-new-pass-1", confirm = pw) => call(resetRoute.POST(json("POST", { token, newPassword: pw, confirmPassword: confirm })));

  it("no account enumeration: same 200 + message for a credentials account, a Google-only account and an unknown email", async () => {
    const a = await forgot("owner@example.test");
    const b = await forgot("google@example.test");
    const c = await forgot("nobody@example.test");
    for (const r of [a, b, c]) expect(r).toEqual({ status: 200, body: { ok: true, message: FORGOT_PASSWORD_MESSAGE } });
    expect(testOutbox.sent.map((m) => ({ to: m.to, subject: m.subject }))).toEqual([
      { to: "owner@example.test", subject: "Reset your Team Balance Pro password" },
      { to: "google@example.test", subject: "Signing in to Team Balance Pro" },
    ]);
    expect(testOutbox.sent[1].text).not.toMatch(/reset-password/); // Google-only: no token, no password is set
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it("only the token HASH is stored; the GET preview never consumes it; reset sets the new password, signs out older sessions and is single-use", async () => {
    await forgot("OWNER@Example.test "); // normalized
    const token = tokenFromEmail();
    const row = await prisma.passwordResetToken.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await getPasswordResetPreview(token)).toEqual({ status: "valid" });
    expect(await getPasswordResetPreview(token)).toEqual({ status: "valid" });

    const oldIat = Math.floor(Date.now() / 1000) - 5;
    expect(await reset(token, "short", "short")).toMatchObject({ status: 400 }); // same rules as sign-up
    expect(await reset(token, "brand-new-pass-1", "different-pass-1")).toMatchObject({ status: 400 });
    expect(await reset(token)).toEqual({ status: 200, body: { ok: true } });
    expect(await authenticateCredentials("owner@example.test", "brand-new-pass-1")).toMatchObject({ id: "u-owner" });
    expect(await authenticateCredentials("owner@example.test", "old-password-123")).toBeNull();

    // Sessions issued before the reset are void; a new sign-in after it works.
    const jwt = authOptions.callbacks!.jwt!;
    expect(await jwt({ token: { uid: "u-owner", email: "owner@example.test", iat: oldIat }, account: null } as never)).toEqual({});
    expect(await jwt({ token: { email: "owner@example.test", iat: oldIat }, account: null } as never)).toEqual({}); // pre-M5 token (email only)
    const fresh = Math.floor(Date.now() / 1000) + 2;
    expect(await jwt({ token: { uid: "u-owner", email: "owner@example.test", iat: fresh }, account: null } as never)).toMatchObject({ uid: "u-owner" });
    // Other users' sessions are untouched.
    expect(await jwt({ token: { uid: "u-admin", email: "admin@example.test", iat: oldIat }, account: null } as never)).toMatchObject({ uid: "u-admin" });

    expect(await reset(token, "another-pass-22")).toMatchObject({ status: 400, body: { code: "RESET_USED" } });
    expect(await getPasswordResetPreview(token)).toEqual({ status: "used" });
  });

  it("expired, invalid and superseded tokens are refused", async () => {
    await forgot("owner@example.test");
    const first = tokenFromEmail();
    await forgot("owner@example.test"); // a new request replaces the older link
    const second = tokenFromEmail();
    expect(await reset(first)).toMatchObject({ status: 400, body: { code: "RESET_INVALID" } });
    expect(await reset("x".repeat(43))).toMatchObject({ status: 400, body: { code: "RESET_INVALID" } });
    expect(await reset("not-a-token")).toMatchObject({ status: 400, body: { code: "RESET_INVALID" } });
    expect(await resetPassword(second, "brand-new-pass-1", new Date(Date.now() + PASSWORD_RESET_TTL_MS + 1))).toEqual({ ok: false, code: "RESET_EXPIRED" });
    expect(await authenticateCredentials("owner@example.test", "old-password-123")).toMatchObject({ id: "u-owner" });
  });

  it("concurrent resets with the same token: exactly one succeeds", async () => {
    await forgot("owner@example.test");
    const token = tokenFromEmail();
    const results = await Promise.all(["pass-one-111", "pass-two-222", "pass-three-333", "pass-four-444"].map((pw) => resetPassword(token, pw)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "RESET_USED")).toBe(true);
  });

  it("rate limits: requests per address (429) and per email (generic answer, nothing sent); submissions per address", async () => {
    await forgot("owner@example.test");
    expect(rateLimitCalls).toEqual([
      { bucket: "password-reset-ip", key: "203.0.113.7" },
      { bucket: "password-reset-email", key: "owner@example.test" },
    ]);
    testOutbox.clear();
    rateLimitDeny = "password-reset-email";
    expect(await forgot("owner@example.test")).toEqual({ status: 200, body: { ok: true, message: FORGOT_PASSWORD_MESSAGE } });
    expect(testOutbox.sent).toEqual([]);
    rateLimitDeny = "password-reset-ip";
    expect((await forgot("owner@example.test")).status).toBe(429);
    rateLimitDeny = "password-reset-submit";
    expect((await reset("x".repeat(43))).status).toBe(429);
  });

  it("a Google-only account can't get a password through a reset token", async () => {
    // Even a token row forged for it is refused (no password is ever invented).
    await prisma.passwordResetToken.create({ data: { userId: "u-google", tokenHash: hashToken("g".repeat(43)), expiresAt: new Date(Date.now() + H) } });
    expect(await reset("g".repeat(43))).toMatchObject({ status: 400, body: { code: "RESET_INVALID" } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-google" } })).passwordHash).toBeNull();
  });
});

describe("M11.3 — no network leaks", () => {
  it("nothing but the fake Telegram was called", () => {
    expect(otherNetwork).toBe(0);
    expect(effectivePlan({ plan: "FREE", trialEndsAt: null })).toBe("FREE");
  });
});
