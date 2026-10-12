/**
 * Phase 4B step 6 — Telegram Game Day Update automation + delivery, REAL
 * DATABASE (guarded local test DB only). Telegram is FAKE: every Bot API call is
 * captured (method + body) and answered by the test; nothing leaves the machine.
 * No weather. Game dates are far in the future; every instant is computed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as automationRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/automation/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { gameDayUpdateStatus } from "@/lib/gameDayUpdate";
import { addDaysYmd, weekdayOfYmd, zonedToUtc } from "@/lib/scheduleTime";

const TZ = "America/New_York";
const H = 3600_000;
const MIN = 60_000;
const VERIFIED = new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------- fake Telegram
type Mode = "ok" | "reject" | "network" | "unreadable";
let mode: Mode = "ok";
let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let seq = 1000;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: { body?: string }): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  calls.push({ method, body: JSON.parse(init?.body ?? "{}") });
  if (method === "sendMessage") {
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "reject") return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) } as unknown as Response;
    if (mode === "unreadable") return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++seq, poll: { id: `tp${seq}` } } }) } as unknown as Response;
}
const sends = () => calls.filter((c) => c.method === "sendMessage");

// ---------------------------------------------------------------- fixtures
const json = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const gm = (matchId: string, org = "o", group = "o-g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });

// Wednesday-ish far-future manual game: kickoff 2099-06-03 21:00 EDT; deadline 17:00 EDT = 21:00Z.
const DATE = "2099-06-03";
const D = zonedToUtc(DATE, "17:00", TZ);
const at = (ms: number) => new Date(D.getTime() + ms);

let chatSeq = -100;
async function org(id: string, plan: { plan: "FREE" | "PRO" | "COMP" | "LEGACY"; trialEndsAt?: Date | null }, opts: { name?: string; visibility?: "LINK" | "PRIVATE" | "PUBLIC" } = {}) {
  await prisma.organization.create({ data: { id, name: `Org ${id}`, slug: id, plan: plan.plan, trialEndsAt: plan.trialEndsAt ?? null } });
  await prisma.group.create({ data: { id: `${id}-g`, organizationId: id, name: opts.name ?? `${id} group`, slug: `${id}-g`, sportKey: "soccer", timezone: TZ, visibility: opts.visibility ?? "LINK" } });
  await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: id, role: "OWNER" } });
  await prisma.groupSetting.create({ data: { groupId: `${id}-g`, key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
  const chatId = BigInt(chatSeq--);
  await prisma.telegramChat.create({ data: { chatId, title: "Chat", groupId: `${id}-g` } });
  return chatId;
}
/** A manual match with an OPEN attendance poll (message 77) posted `pollBefore` before the deadline. */
async function manualMatch(groupId: string, chatId: bigint, id: string, opts: { deadline?: Date; pollAt?: Date; messageId?: number; data?: Record<string, unknown> } = {}) {
  await prisma.match.create({ data: { id, groupId, date: new Date(`${DATE}T00:00:00Z`), startTime: "21:00", attendanceDeadlineAt: opts.deadline ?? D, ...opts.data } });
  await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId, messageId: BigInt(opts.messageId ?? 77), question: "Q", optionsJson: "[]", groupId, matchId: id, kind: "ATTENDANCE", createdAt: opts.pollAt ?? new Date(D.getTime() - 24 * H) } });
}
const setHours = (groupId: string, hoursBefore: number, extra: Record<string, unknown> = {}) =>
  prisma.groupSetting.update({ where: { groupId_key: { groupId, key: "gameDayUpdate" } }, data: { value: JSON.stringify({ enabled: true, hoursBefore, includeWeather: true, units: "imperial", ...extra }) } });
const deliveries = (matchId: string) => prisma.messageDelivery.findMany({ where: { matchId, eventType: "GAME_DAY_UPDATE_POSTED" }, orderBy: { createdAt: "asc" } });
const status = (orgId: string, matchId: string, now: Date) => gameDayUpdateStatus(`${orgId}-g`, orgId, matchId, false, now);
let CHAT: bigint;

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "https://tbp.itest");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("MATCH_SHARE_SECRET", "phase4b-gameday-test-secret-0123456789abcdef");
});
beforeEach(async () => {
  mode = "ok";
  calls = [];
  chatSeq = -100;
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  CHAT = await org("o", { plan: "LEGACY" }, { name: "Indoor Soccer" });
  await prisma.organizationMembership.create({ data: { userId: "u-member", organizationId: "o", role: "MEMBER" } });
  signIn("owner");
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ================================================================ timing
describe("timing: deadline − offset, the 60-minute poll settle, the 30-minute minimum", () => {
  it.each([2, 4, 6, 12])("offset %i h: not before it is due; sent once it is (reply to the poll, actual time left)", async (h) => {
    await setHours("o-g", h);
    await manualMatch("o-g", CHAT, "m");
    expect((await runMatchAutomation(at(-h * H - MIN))).gameDayUpdates).toBe(0);
    expect(await status("o", "m", at(-h * H - MIN))).toMatchObject({ state: "WAIT", at: at(-h * H).toISOString() });
    const run = await runMatchAutomation(at(-h * H + MIN));
    expect(run.gameDayUpdates).toBe(1);
    expect(sends()).toHaveLength(1);
    const body = sends()[0].body;
    expect(body).toMatchObject({ chat_id: CHAT.toString(), parse_mode: "HTML", disable_web_page_preview: true, reply_parameters: { message_id: 77, allow_sending_without_reply: true } });
    const minutesLeft = h * 60 - 1;
    expect(String(body.text)).toContain(`closes in ${h - 1 ? `${h - 1} hour${h - 1 === 1 ? "" : "s"} 59 minutes` : "59 minutes"}`);
    expect(minutesLeft).toBeGreaterThan(0);
    expect(await deliveries("m")).toEqual([expect.objectContaining({ status: "SENT", destination: CHAT.toString(), telegramPollId: "poll-m", providerMessageId: expect.any(String) })]);
  });

  it("a late cron run still sends while ≥ 30 minutes remain — stating the real time left", async () => {
    await manualMatch("o-g", CHAT, "m");
    expect((await runMatchAutomation(at(-H))).gameDayUpdates).toBe(1);
    expect(String(sends()[0].body.text)).toContain("⏰ Attendance closes in 1 hour (5:00 PM EDT).");
  });

  it("missed: under 30 minutes left → never sent ('too close'); after the deadline → never", async () => {
    await manualMatch("o-g", CHAT, "m");
    expect((await runMatchAutomation(at(-25 * MIN))).gameDayUpdates).toBe(0);
    expect(await status("o", "m", at(-25 * MIN))).toMatchObject({ state: "TOO_CLOSE" });
    expect((await runMatchAutomation(at(MIN))).gameDayUpdates).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it("a poll posted late: waits 60 minutes after the poll; a poll too close to the deadline → too close", async () => {
    await manualMatch("o-g", CHAT, "late", { pollAt: at(-3 * H) }); // offset 4 h → due = poll + 60 min = D − 2 h
    expect((await runMatchAutomation(at(-2 * H - MIN))).gameDayUpdates).toBe(0);
    expect((await runMatchAutomation(at(-2 * H + MIN))).gameDayUpdates).toBe(1);
    await manualMatch("o-g", CHAT, "tooclose", { pollAt: at(-80 * MIN), messageId: 78 }); // due = D − 20 min → never
    expect(await status("o", "tooclose", at(-70 * MIN))).toMatchObject({ state: "TOO_CLOSE" });
    expect((await runMatchAutomation(at(-15 * MIN))).gameDayUpdates).toBe(0);
  });
});

// ================================================================ one per match
describe("one Game Day Update per match: locks, parallel runs, failures and uncertainty", () => {
  it("parallel automation runs (cron + Run now) send exactly once", async () => {
    await manualMatch("o-g", CHAT, "m");
    const t = at(-3 * H);
    const runs = await Promise.all([runMatchAutomation(t), runMatchAutomation(t), runMatchAutomation(t, { groupId: "o-g", matchId: "m" }), runMatchAutomation(t, { groupId: "o-g" })]);
    expect(runs.reduce((n, r) => n + r.gameDayUpdates, 0)).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(await deliveries("m")).toHaveLength(1);
  });

  it("SENT is final: a later deadline change (or offset change) never sends a second one", async () => {
    await manualMatch("o-g", CHAT, "m");
    await runMatchAutomation(at(-3 * H));
    await prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: at(6 * H) } });
    await setHours("o-g", 2);
    await runMatchAutomation(at(5 * H));
    expect(sends()).toHaveLength(1);
    expect(await status("o", "m", at(5 * H))).toMatchObject({ state: "SENT" });
  });

  it("a definite Telegram rejection is FAILED and retried while eligible (one row, attempts 2)", async () => {
    await manualMatch("o-g", CHAT, "m");
    mode = "reject";
    const r = await runMatchAutomation(at(-3 * H));
    expect(r).toMatchObject({ gameDayUpdates: 0, gameDayProblems: 1 });
    expect(await deliveries("m")).toEqual([expect.objectContaining({ status: "FAILED", failureCode: "TELEGRAM_REJECTED" })]);
    expect(await status("o", "m", at(-3 * H + MIN))).toMatchObject({ state: "RETRY" });
    mode = "ok";
    expect((await runMatchAutomation(at(-2 * H))).gameDayUpdates).toBe(1);
    expect(await deliveries("m")).toEqual([expect.objectContaining({ status: "SENT", attempts: 2 })]);
  });

  it.each(["network", "unreadable"] as const)("an uncertain outcome (%s) is never retried automatically", async (m) => {
    await manualMatch("o-g", CHAT, "m");
    mode = m;
    expect((await runMatchAutomation(at(-3 * H))).gameDayProblems).toBe(1);
    mode = "ok";
    await runMatchAutomation(at(-2 * H));
    await runMatchAutomation(at(-H));
    expect(sends()).toHaveLength(1);
    expect(await deliveries("m")).toEqual([expect.objectContaining({ status: "UNCERTAIN" })]);
    expect(await status("o", "m", at(-H))).toMatchObject({ state: "UNCERTAIN", text: "Delivery uncertain — review the Telegram chat" });
  });
});

// ================================================================ eligibility
describe("eligibility from the current database state", () => {
  it("no poll / closed poll / disconnected chat → nothing sent (no false SENT)", async () => {
    await prisma.match.create({ data: { id: "nopoll", groupId: "o-g", date: new Date(`${DATE}T00:00:00Z`), startTime: "21:00", attendanceDeadlineAt: D } });
    await manualMatch("o-g", CHAT, "closedpoll");
    await prisma.telegramPoll.update({ where: { pollId: "poll-closedpoll" }, data: { isClosed: true } });
    await runMatchAutomation(at(-3 * H));
    expect(await status("o", "nopoll", at(-3 * H))).toMatchObject({ state: "NO_POLL" });
    await manualMatch("o-g", CHAT, "disc", { messageId: 79 });
    await prisma.telegramChat.updateMany({ where: { chatId: CHAT }, data: { disconnectedAt: new Date() } });
    await runMatchAutomation(at(-3 * H));
    expect(await status("o", "disc", at(-3 * H))).toMatchObject({ state: "CHAT_DISCONNECTED" });
    expect(sends()).toHaveLength(0);
    expect(await prisma.messageDelivery.count({ where: { eventType: "GAME_DAY_UPDATE_POSTED" } })).toBe(0);
  });

  it("canceled, completed, closed by hand, no deadline → never", async () => {
    await manualMatch("o-g", CHAT, "canceled", { data: { status: "CANCELED" } });
    await manualMatch("o-g", CHAT, "completed", { messageId: 81, data: { status: "COMPLETED" } });
    await manualMatch("o-g", CHAT, "closed", { messageId: 82, data: { attendanceClosedAt: new Date() } });
    await manualMatch("o-g", CHAT, "nodeadline", { messageId: 83 });
    await prisma.match.update({ where: { id: "nodeadline" }, data: { attendanceDeadlineAt: null } });
    await runMatchAutomation(at(-3 * H));
    expect(sends()).toHaveLength(0);
    expect((await status("o", "nodeadline", at(-3 * H)))?.state).toBe("NO_DEADLINE");
    expect((await status("o", "closed", at(-3 * H)))?.state).toBe("CLOSED");
    expect((await status("o", "canceled", at(-3 * H)))?.state).toBe("INACTIVE");
  });

  it("disabled in Group Settings after scheduling → not sent ('Disabled in Group Settings')", async () => {
    await manualMatch("o-g", CHAT, "m");
    expect(await status("o", "m", at(-5 * H))).toMatchObject({ state: "WAIT" });
    await setHours("o-g", 4, { enabled: false });
    await runMatchAutomation(at(-3 * H));
    expect(sends()).toHaveLength(0);
    expect(await status("o", "m", at(-3 * H))).toMatchObject({ state: "DISABLED", text: "Disabled in Group Settings" });
  });

  it("plans: Free and expired trial never; Trial, Pro, Complimentary, Legacy yes; a downgrade stops unsent ones", async () => {
    const plans = {
      free: { plan: "FREE" as const },
      expired: { plan: "FREE" as const, trialEndsAt: new Date("2026-01-01T00:00:00Z") },
      trial: { plan: "FREE" as const, trialEndsAt: new Date("2100-01-01T00:00:00Z") },
      pro: { plan: "PRO" as const },
      comp: { plan: "COMP" as const },
    };
    const chats: Record<string, bigint> = {};
    for (const [id, p] of Object.entries(plans)) {
      chats[id] = await org(id, p);
      await manualMatch(`${id}-g`, chats[id], `m-${id}`);
    }
    await manualMatch("o-g", CHAT, "m-legacy"); // "o" is LEGACY
    await prisma.organization.update({ where: { id: "pro" }, data: { plan: "FREE" } }); // downgraded after enabling
    await runMatchAutomation(at(-3 * H));
    expect(sends().map((s) => s.body.chat_id).sort()).toEqual([chats.trial, chats.comp, CHAT].map(String).sort());
    expect((await status("free", "m-free", at(-3 * H)))?.state).toBe("NOT_IN_PLAN");
    expect((await status("pro", "m-pro", at(-3 * H)))?.state).toBe("NOT_IN_PLAN");
  });

  it("multi-chat: only the chat of the match's CURRENT (latest open) poll, replying to that poll; never another chat", async () => {
    const chat2 = BigInt(-555);
    await prisma.telegramChat.create({ data: { chatId: chat2, title: "Second", groupId: "o-g" } });
    await manualMatch("o-g", CHAT, "m", { pollAt: at(-30 * H) });
    await prisma.telegramPoll.create({ data: { pollId: "poll-m-2", chatId: chat2, messageId: 900n, question: "Q", optionsJson: "[]", groupId: "o-g", matchId: "m", kind: "ATTENDANCE", createdAt: at(-20 * H) } });
    await runMatchAutomation(at(-3 * H));
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toMatchObject({ chat_id: chat2.toString(), reply_parameters: { message_id: 900 } });
  });
});

// ================================================================ content
describe("content: escaping, attendance overrides, links", () => {
  it("escapes the group's name; counts use effective attendance (organizer overrides included); no names", async () => {
    await prisma.group.update({ where: { id: "o-g" }, data: { name: "A&B <Eagles>" } });
    await manualMatch("o-g", CHAT, "m");
    const players = ["p1", "p2", "p3", "p4"];
    await prisma.player.createMany({ data: players.map((id) => ({ id, groupId: "o-g", firstName: `Secret${id}`, lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3 })) });
    await prisma.attendanceResponse.createMany({
      data: [
        { matchId: "m", groupId: "o-g", playerId: "p1", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: at(-5 * H) },
        { matchId: "m", groupId: "o-g", playerId: "p2", participantStatus: "NOT_PLAYING", participantSource: "WEB", participantRespondedAt: at(-5 * H), overrideStatus: "PLAYING", overrideAt: at(-5 * H) },
        { matchId: "m", groupId: "o-g", playerId: "p3", participantStatus: "MAYBE", participantSource: "TELEGRAM", participantRespondedAt: at(-5 * H) },
      ],
    });
    await runMatchAutomation(at(-3 * H));
    const text = String(sends()[0].body.text);
    expect(text).toContain("<b>⚽ Game Day Update — A&amp;B &lt;Eagles&gt;</b>");
    expect(text).toContain("👥 2 players confirmed · 1 maybe");
    expect(text).not.toMatch(/Secret|rating|GOOD/);
  });

  it("Match Link only when allowed (LINK / PUBLIC group with the share secret); PRIVATE → no link", async () => {
    await manualMatch("o-g", CHAT, "m");
    await runMatchAutomation(at(-3 * H));
    expect(String(sends()[0].body.text)).toMatch(/<a href="https:\/\/tbp\.itest\/share\/m\/m#[^"]+">Confirm or update your attendance<\/a>/);
    calls = [];
    const privChat = await org("priv", { plan: "LEGACY" }, { visibility: "PRIVATE" });
    await manualMatch("priv-g", privChat, "pm");
    await runMatchAutomation(at(-3 * H));
    expect(String(sends()[0].body.text)).not.toContain("<a ");
  });
});

// ================================================================ recurring + Run now + visibility
describe("recurring matches, Run now, organizer-only status, tenant isolation", () => {
  const GAME = (() => {
    let d = "2099-06-01";
    while (weekdayOfYmd(d) !== 1) d = addDaysYmd(d, 1);
    return d;
  })();
  const SCHED = { groupId: "o-g", communityId: "c", timezone: TZ, weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
  const CUTOFF = zonedToUtc(GAME, "20:00", TZ);

  async function recurring() {
    await prisma.community.create({ data: { id: "c", groupId: "o-g", name: "Mondays" } });
    await prisma.telegramChat.updateMany({ where: { chatId: CHAT }, data: { communityId: "c" } });
    const s = await prisma.matchSchedule.create({ data: SCHED });
    await runMatchAutomation(new Date(zonedToUtc(addDaysYmd(GAME, -1), "20:05", TZ))); // creates the match + posts its poll (fake)
    const match = await prisma.match.findFirstOrThrow({ where: { scheduleId: s.id } });
    await prisma.telegramPoll.updateMany({ where: { matchId: match.id }, data: { createdAt: new Date(CUTOFF.getTime() - 24 * H) } });
    calls = [];
    return { s, match };
  }

  it("a recurring match gets its update before its cutoff; a paused schedule gets none", async () => {
    const { s, match } = await recurring();
    await prisma.matchSchedule.update({ where: { id: s.id }, data: { isActive: false } });
    await runMatchAutomation(new Date(CUTOFF.getTime() - 3 * H));
    expect(sends()).toHaveLength(0);
    expect((await status("o", match.id, new Date(CUTOFF.getTime() - 3 * H)))?.state).toBe("SCHEDULE_PAUSED");
    await prisma.matchSchedule.update({ where: { id: s.id }, data: { isActive: true } });
    expect((await runMatchAutomation(new Date(CUTOFF.getTime() - 3 * H))).gameDayUpdates).toBe(1);
  });

  it("Run now (organizers) works for recurring AND manual matches through the same engine", async () => {
    const { match } = await recurring();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(CUTOFF.getTime() - 3 * H));
    const r = await call(automationRoute.POST(json("POST"), gm(match.id)));
    expect(r).toMatchObject({ status: 200, body: { ok: true, gameDayUpdates: 1 } });
    await manualMatch("o-g", CHAT, "manual", { messageId: 501 });
    vi.setSystemTime(at(-3 * H));
    expect(await call(automationRoute.POST(json("POST"), gm("manual")))).toMatchObject({ status: 200, body: { ok: true, created: 0, gameDayUpdates: 1 } });
    vi.useRealTimers();
    expect(await prisma.match.count()).toBe(2); // the manual Run now never touched the schedule
    signIn("member");
    expect((await call(automationRoute.POST(json("POST"), gm("manual")))).status).toBe(404);
  });

  it("status is organizer-only on the match page; other tenants get 404; runs scoped to a group never send another group's", async () => {
    await manualMatch("o-g", CHAT, "m");
    expect((await call(matchRoute.GET(json("GET"), gm("m")))).body.gameDayUpdate).toMatchObject({ state: expect.any(String), text: expect.any(String) });
    signIn("member");
    expect((await call(matchRoute.GET(json("GET"), gm("m")))).body.gameDayUpdate).toBeNull();
    const otherChat = await org("x", { plan: "LEGACY" });
    await manualMatch("x-g", otherChat, "xm", { messageId: 600 });
    signIn("other");
    expect((await call(matchRoute.GET(json("GET"), gm("m")))).status).toBe(404);
    await runMatchAutomation(at(-3 * H), { groupId: "x-g" });
    expect(sends().map((s) => s.body.chat_id)).toEqual([otherChat.toString()]);
    expect(await deliveries("m")).toHaveLength(0);
  });

  it("no network beyond the fake Telegram", () => {
    expect(otherNetwork).toBe(0);
  });
});
