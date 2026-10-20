/**
 * Manual "Send Game Day Update now" — REAL DATABASE (guarded local test DB only),
 * through the organizer routes. Telegram and weather are FAKE: every Bot API
 * call is captured and answered by the test, the weather provider is a test
 * double; any other network access fails the test. Nothing leaves the machine.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as previewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/game-day-update/preview/route";
import * as sendRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/game-day-update/send/route";
import * as markRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/game-day-update/mark-sent/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as webhookRoute from "@/app/api/telegram/webhook/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { resetGameDayPreviewLimitForTests } from "@/lib/gameDayManual";
import { setWeatherProviderForTests } from "@/lib/weather";
import { WEATHER_ATTRIBUTION, WEATHER_DISCLAIMER } from "@/lib/weatherLegal";
import { addDaysYmd, weekdayOfYmd, zonedToUtc } from "@/lib/scheduleTime";
import type { GameDayPreview } from "@/lib/gameDayUpdate";

const TZ = "America/New_York";
const H = 3600_000;
const MIN = 60_000;
const VERIFIED = new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------- fake Telegram
type Mode = "ok" | "reject" | "network" | "replyGone";
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
    if (mode === "replyGone") return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: message to be replied not found" }) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++seq, poll: { id: `tp${seq}` } } }) } as unknown as Response;
}
const sends = () => calls.filter((c) => c.method === "sendMessage");

// ---------------------------------------------------------------- fake weather
let weatherCalls = 0;
const FORECAST = { temperatureC: 20, condition: "Partly cloudy", rainChancePercent: 10, windKph: 16.09344, attributionLink: WEATHER_ATTRIBUTION, disclaimer: WEATHER_DISCLAIMER };
let forecast: typeof FORECAST | null = FORECAST;

// ---------------------------------------------------------------- helpers
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const ctx = (matchId: string, org = "o", group = "o-g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const json = (body: unknown) => new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function preview(matchId = "m", org = "o", group = "o-g") {
  const r = await previewRoute.POST(new Request("http://itest.local/", { method: "POST" }), ctx(matchId, org, group));
  const body = (await r.json().catch(() => ({}))) as { preview?: GameDayPreview; error?: string };
  return { status: r.status, preview: body.preview!, body };
}
async function send(token: unknown, matchId = "m", org = "o", group = "o-g") {
  const r = await sendRoute.POST(json({ token }), ctx(matchId, org, group));
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { result?: string; reason?: string; error?: string } };
}
async function markSent(deliveryId: string, matchId = "m", org = "o", group = "o-g") {
  const r = await markRoute.POST(json({ deliveryId }), ctx(matchId, org, group));
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const deliveries = (matchId = "m") => prisma.messageDelivery.findMany({ where: { matchId, eventType: "GAME_DAY_UPDATE_POSTED" }, orderBy: { createdAt: "asc" } });
const setNow = (t: Date) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

// Far-future manual game: kickoff 2099-06-03 21:00 EDT; deadline 17:00 EDT.
const DATE = "2099-06-03";
const D = zonedToUtc(DATE, "17:00", TZ);
const at = (ms: number) => new Date(D.getTime() + ms);
const CHAT = -100n;
let CHAT_REF = 0;

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n === "owner" ? "Olivia Owner" : n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const [o, chat, title] of [["o", CHAT, "FunnyStuff"], ["x", -200n, "Other Org Chat"]] as const) {
    await prisma.organization.create({ data: { id: o, name: `Org ${o}`, slug: o, plan: "LEGACY" } });
    await prisma.group.create({ data: { id: `${o}-g`, organizationId: o, name: "Indoor Soccer", slug: `${o}-g`, sportKey: "soccer", timezone: TZ, visibility: "PRIVATE" } });
    const c = await prisma.telegramChat.create({ data: { chatId: chat, title, groupId: `${o}-g` } });
    if (o === "o") CHAT_REF = c.id;
    await prisma.venue.create({ data: { id: `${o}-v`, organizationId: o, name: "ForeKicks", address: "10 Pine St, Norfolk, MA", weatherLatitude: 42.1195, weatherLongitude: -71.3251, weatherLocationLabel: "Norfolk, MA", weatherLocationConfirmedAt: VERIFIED } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "x", role: "OWNER" },
    ],
  });
  // NOTE: no "gameDayUpdate" GroupSetting row → automatic Game Day Updates are OFF (the default).
}
/** A manual match whose selected Telegram group is FunnyStuff, with an OPEN attendance poll there (message 77). */
async function match(id = "m", opts: { deadline?: Date | null; pollAt?: Date; data?: Record<string, unknown>; poll?: Record<string, unknown> | null } = {}) {
  await prisma.match.create({ data: { id, groupId: "o-g", date: new Date(`${DATE}T00:00:00Z`), startTime: "21:00", venueId: "o-v", telegramChatId: CHAT_REF, attendanceDeadlineAt: opts.deadline === undefined ? D : opts.deadline, ...opts.data } });
  if (opts.poll !== null) await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId: CHAT, messageId: 77n, question: "Soccer Wed Jun 3 9 PM?", optionsJson: "[]", groupId: "o-g", matchId: id, kind: "ATTENDANCE", createdAt: opts.pollAt ?? at(-24 * H), ...opts.poll } });
}
async function players() {
  await prisma.player.createMany({ data: ["p1", "p2", "p3"].map((id) => ({ id, groupId: "o-g", firstName: `Secret${id}`, lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3 })) });
  await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "o-g", playerId: "p1", participantStatus: "PLAYING", participantSource: "TELEGRAM", participantRespondedAt: at(-20 * H) } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "https://tbp.itest");
  vi.stubEnv("NEXTAUTH_SECRET", "manual-gameday-itest-secret-0123456789");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});
beforeEach(async () => {
  mode = "ok";
  calls = [];
  otherNetwork = 0;
  weatherCalls = 0;
  forecast = FORECAST;
  setWeatherProviderForTests({
    forecastAt: async () => {
      weatherCalls++;
      return forecast;
    },
  });
  resetGameDayPreviewLimitForTests();
  await seed();
  await match();
  await players();
  signIn("owner");
  setNow(at(-3 * H));
});
afterEach(() => {
  vi.useRealTimers();
  setWeatherProviderForTests(null);
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ================================================================ preview + send
describe("preview and confirmed send", () => {
  it("preview is read-only: destination, poll, deadline, exact message and weather — nothing sent, nothing stored, automatic stays off", async () => {
    const { status, preview: p } = await preview();
    expect(status).toBe(200);
    expect(p).toMatchObject({
      state: "READY",
      organization: "Org o",
      group: "Indoor Soccer",
      destination: { chatTitle: "FunnyStuff", pollQuestion: "Soccer Wed Jun 3 9 PM?" },
      deadline: { at: D.toISOString(), timeLeft: "3 hours" },
      automaticEnabled: false,
      weather: { reason: "INCLUDED", includedInMessage: true, forecast: { temperatureC: 20, condition: "Partly cloudy" } },
      expiresInSeconds: 120,
    });
    expect(p.message!.html).toContain("⏰ Attendance closes today at 5:00 PM EDT."); // M12B — absolute time
    expect(p.message!.html).toContain("👥 Attendance Summary (3 players)\n✅ Playing: 1\n❌ Not Playing: 0\n🤔 Maybe: 0\n⏳ Not Responded: 2");
    expect(p.message!.html).toContain("68°F");
    expect(p.message!.html).not.toContain("Secret"); // counts only, never names
    expect(p.token).toEqual(expect.any(String));
    expect(calls).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    expect(await prisma.groupSetting.count({ where: { key: "gameDayUpdate" } })).toBe(0);
  });

  it("sends EXACTLY the previewed text, as a strict reply to the poll, to the selected group only — automatic stays off", async () => {
    const { preview: p } = await preview();
    const r = await send(p.token);
    expect(r).toMatchObject({ status: 200, body: { result: "sent" } });
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toEqual({ chat_id: CHAT.toString(), text: p.message!.html, parse_mode: "HTML", disable_web_page_preview: true, reply_parameters: { message_id: 77, allow_sending_without_reply: false } });
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", destination: CHAT.toString(), telegramPollId: "poll-m", createdByUserId: "u-owner", channel: "TELEGRAM" })]);
    expect(await prisma.groupSetting.count({ where: { key: "gameDayUpdate" } })).toBe(0); // never enables automatic reminders
    expect(otherNetwork).toBe(0);
  });

  it("the send reuses the previewed weather snapshot (no second forecast request)", async () => {
    const { preview: p } = await preview();
    expect(weatherCalls).toBe(1);
    forecast = { ...FORECAST, temperatureC: 35 };
    expect((await send(p.token)).body.result).toBe("sent");
    expect(weatherCalls).toBe(1);
    expect(String(sends()[0].body.text)).toContain("68°F");
  });

  it("works right after the poll is posted and long before the automatic due time", async () => {
    await prisma.telegramPoll.update({ where: { pollId: "poll-m" }, data: { createdAt: at(-10 * H - MIN) } });
    setNow(at(-10 * H));
    const { preview: p } = await preview();
    expect(p.state).toBe("READY");
    expect((await send(p.token)).body.result).toBe("sent");
  });

  it("a recurring match (even with its schedule paused) is supported", async () => {
    let game = "2099-06-01";
    while (weekdayOfYmd(game) !== 1) game = addDaysYmd(game, 1);
    await prisma.community.create({ data: { id: "c", groupId: "o-g", name: "Mondays" } });
    await prisma.telegramChat.updateMany({ where: { chatId: CHAT }, data: { communityId: "c" } });
    const s = await prisma.matchSchedule.create({ data: { groupId: "o-g", communityId: "c", timezone: TZ, weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" } });
    vi.useRealTimers();
    await runMatchAutomation(new Date(zonedToUtc(addDaysYmd(game, -1), "20:05", TZ))); // creates the match + posts its poll (fake)
    const rec = await prisma.match.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(rec.telegramChatId).toBe(CHAT_REF);
    await prisma.matchSchedule.update({ where: { id: s.id }, data: { isActive: false } });
    calls = [];
    setNow(new Date(zonedToUtc(game, "18:00", TZ).getTime()));
    const { preview: p } = await preview(rec.id);
    expect(p.state).toBe("READY");
    expect((await send(p.token, rec.id)).body.result).toBe("sent");
    expect(sends()).toHaveLength(1);
  });
});

// ================================================================ permissions + tenant isolation
describe("permissions and tenant isolation", () => {
  it("OWNER and ADMIN may preview; MEMBER and outsiders get 404 on every endpoint", async () => {
    signIn("admin");
    expect((await preview()).preview.state).toBe("READY");
    for (const who of ["member", "other"]) {
      signIn(who);
      expect((await preview()).status).toBe(404);
      expect((await send("x")).status).toBe(404);
      expect((await markSent("x")).status).toBe(404);
    }
    expect(sends()).toHaveLength(0);
  });

  it("another organization's URL never reaches this match; a token is bound to its match and reviewer", async () => {
    signIn("other");
    expect((await preview("m", "x", "x-g")).status).toBe(404);
    signIn("owner");
    const { preview: p } = await preview();
    await match("m2", { poll: { pollId: "poll-m2", messageId: 78n } });
    expect(await send(p.token, "m2")).toMatchObject({ status: 400, body: { result: "invalid" } }); // token of another match
    signIn("admin");
    expect(await send(p.token)).toMatchObject({ status: 400, body: { result: "invalid" } }); // reviewed by another organizer
    expect(await send("forged.token")).toMatchObject({ status: 400 });
    expect(sends()).toHaveLength(0);
  });

  it("plans without Telegram: unavailable", async () => {
    await prisma.organization.update({ where: { id: "o" }, data: { plan: "FREE", trialEndsAt: null } });
    const { preview: p } = await preview();
    expect(p).toMatchObject({ state: "UNAVAILABLE", reason: "NOT_IN_PLAN", token: null });
  });

  it("previews are rate-limited per organizer", async () => {
    for (let i = 0; i < 10; i++) expect((await preview()).status).toBe(200);
    expect((await preview()).status).toBe(429);
  });
});

// ================================================================ deadline + destination
describe("deadline and destination checks", () => {
  it("no deadline: a helpful explanation, no invented deadline, no message, no token", async () => {
    await prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: null } });
    const { preview: p } = await preview();
    expect(p).toMatchObject({ state: "UNAVAILABLE", reason: "NO_DEADLINE", deadline: null, message: null, token: null });
    expect(p.text).toContain("Set one in Edit match");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m" } })).attendanceDeadlineAt).toBeNull();
  });

  it("the 30-minute minimum is enforced at preview AND at send time", async () => {
    setNow(at(-31 * MIN));
    const { preview: p } = await preview();
    expect(p.state).toBe("READY");
    setNow(at(-29.5 * MIN)); // 90 s later: still within the 2-minute preview validity, but under 30 minutes left
    expect(await send(p.token)).toMatchObject({ status: 409, body: { result: "unavailable", reason: "TOO_CLOSE" } });
    expect((await preview()).preview).toMatchObject({ state: "UNAVAILABLE", reason: "TOO_CLOSE" });
    expect(sends()).toHaveLength(0);
  });

  it.each([
    ["no poll", async () => prisma.telegramPoll.deleteMany({ where: { matchId: "m" } }), "NO_POLL"],
    ["closed poll", async () => prisma.telegramPoll.update({ where: { pollId: "poll-m" }, data: { isClosed: true } }), "NO_POLL"],
    ["poll without a message", async () => prisma.telegramPoll.update({ where: { pollId: "poll-m" }, data: { messageId: null } }), "NO_POLL"],
    ["disconnected chat", async () => prisma.telegramChat.update({ where: { id: CHAT_REF }, data: { disconnectedAt: new Date() } }), "CHAT_DISCONNECTED"],
    ["attendance closed", async () => prisma.match.update({ where: { id: "m" }, data: { attendanceClosedAt: at(-4 * H) } }), "CLOSED"],
    ["canceled match", async () => prisma.match.update({ where: { id: "m" }, data: { status: "CANCELED" } }), "INACTIVE"],
  ] as const)("%s → unavailable (%s), never sent — also with a token from before", async (_n, change, reason) => {
    const { preview: before } = await preview();
    await change();
    expect((await preview()).preview).toMatchObject({ state: "UNAVAILABLE", reason, token: null });
    expect((await send(before.token)).status).toBe(409);
    expect(sends()).toHaveLength(0);
  });

  it("mismatched destination: the open poll is in another group than the match's selected group → never sent, never switched", async () => {
    const other = await prisma.telegramChat.create({ data: { chatId: -555n, title: "Real Soccer Chat", groupId: "o-g" } });
    const { preview: before } = await preview();
    await prisma.match.update({ where: { id: "m" }, data: { telegramChatId: other.id } });
    expect((await preview()).preview).toMatchObject({ state: "UNAVAILABLE", reason: "CHAT_MISMATCH", token: null });
    expect(await send(before.token)).toMatchObject({ status: 409, body: { reason: "CHAT_MISMATCH" } });
    expect(sends()).toHaveLength(0);
  });
});

// ================================================================ stale previews
describe("stale previews are rejected (nothing sent)", () => {
  it("expired: older than 2 minutes", async () => {
    const { preview: p } = await preview();
    setNow(at(-3 * H + 2 * MIN));
    expect(await send(p.token)).toMatchObject({ status: 409, body: { result: "stale" } });
    expect(sends()).toHaveLength(0);
  });

  it.each([
    ["attendance changed", async () => prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "o-g", playerId: "p2", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } })],
    ["organizer override", async () => prisma.attendanceResponse.update({ where: { matchId_playerId: { matchId: "m", playerId: "p1" } }, data: { overrideStatus: "NOT_PLAYING", overrideAt: new Date() } })],
    ["deadline changed", async () => prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: at(H) } })],
    ["poll re-posted", async () => {
      await prisma.telegramPoll.update({ where: { pollId: "poll-m" }, data: { isClosed: true } });
      await prisma.telegramPoll.create({ data: { pollId: "poll-m-new", chatId: CHAT, messageId: 79n, question: "Q", optionsJson: "[]", groupId: "o-g", matchId: "m", kind: "ATTENDANCE", createdAt: new Date() } });
    }],
    ["venue renamed (message text differs)", async () => prisma.venue.update({ where: { id: "o-v" }, data: { name: "New Field" } })],
    ["weather turned off (message text differs)", async () => prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: false, hoursBefore: 4, includeWeather: false, units: "imperial" }) } })],
  ] as const)("%s", async (_n, change) => {
    const { preview: p } = await preview();
    await change();
    expect(await send(p.token)).toMatchObject({ status: 409, body: { result: "stale" } });
    expect(sends()).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
  });
});

// ================================================================ one per match + delivery outcomes
describe("one successful Game Day Update per match (manual + automatic), uncertain and failed outcomes", () => {
  it("after a manual send: preview says Already sent (by whom); the old token, a second send and automation send nothing", async () => {
    const { preview: p } = await preview();
    expect((await send(p.token)).body.result).toBe("sent");
    const again = (await preview()).preview;
    expect(again).toMatchObject({ state: "ALREADY_SENT", token: null, sent: { by: "Olivia Owner", markedSent: false } });
    expect(await send(p.token)).toMatchObject({ status: 409, body: { result: "already_sent" } });
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    vi.useRealTimers();
    await runMatchAutomation(at(-2 * H));
    expect(sends()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it("after an automatic send: the manual action shows Already sent and cannot send", async () => {
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: false, units: "imperial" }) } });
    const { preview: p } = await preview();
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(1);
    expect((await preview()).preview).toMatchObject({ state: "ALREADY_SENT" });
    expect((await send(p.token)).body.result).toBe("already_sent");
    expect(sends()).toHaveLength(1);
  });

  it("concurrent manual sends (double click, two organizers' tabs) → exactly one Telegram message", async () => {
    const { preview: p } = await preview();
    const results = await Promise.all([send(p.token), send(p.token), send(p.token), send(p.token)]);
    expect(results.filter((r) => r.body.result === "sent")).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", attempts: 1 })]);
  });

  it("concurrent manual send and automation run (cron) → exactly one Telegram message", async () => {
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    const { preview: p } = await preview();
    const [manual, auto1, auto2] = await Promise.all([send(p.token), runMatchAutomation(at(-3 * H)), runMatchAutomation(at(-3 * H))]);
    expect((manual.body.result === "sent" ? 1 : 0) + auto1.gameDayUpdates + auto2.gameDayUpdates).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it("UNCERTAIN: never re-sent (manual or automatic); only 'Mark as sent' after checking Telegram, with the audit fields", async () => {
    const { preview: p } = await preview();
    mode = "network";
    expect(await send(p.token)).toMatchObject({ status: 502, body: { result: "uncertain" } });
    mode = "ok";
    const u = (await preview()).preview;
    expect(u).toMatchObject({ state: "UNCERTAIN", token: null, uncertainDeliveryId: expect.any(String) });
    expect((await send(p.token)).body).toMatchObject({ result: "unavailable", reason: "UNCERTAIN" });
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(0);
    expect(sends()).toHaveLength(1);

    signIn("member");
    expect((await markSent(u.uncertainDeliveryId!)).status).toBe(404);
    signIn("admin");
    expect((await markSent("not-the-delivery")).status).toBe(409);
    expect(await markSent(u.uncertainDeliveryId!)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", resolution: "MARKED_SENT", resolvedByUserId: "u-admin", resolvedAt: expect.any(Date) })]);
    expect((await preview()).preview).toMatchObject({ state: "ALREADY_SENT", sent: { by: "admin", markedSent: true } });
    expect((await markSent(u.uncertainDeliveryId!)).status).toBe(409); // only an uncertain one
    expect(sends()).toHaveLength(1);
  });

  it("FAILED (definite rejection): may be sent again manually — the same row, attempts 2", async () => {
    mode = "reject";
    expect(await send((await preview()).preview.token)).toMatchObject({ status: 502, body: { result: "failed" } });
    mode = "ok";
    const again = (await preview()).preview;
    expect(again.state).toBe("READY");
    expect((await send(again.token)).body.result).toBe("sent");
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", attempts: 2 })]);
  });

  it("the poll message is gone: terminal, never sent without the reply", async () => {
    mode = "replyGone";
    expect((await send((await preview()).preview.token)).body.result).toBe("failed");
    mode = "ok";
    expect((await preview()).preview).toMatchObject({ state: "UNAVAILABLE", reason: "POLL_MESSAGE_MISSING", token: null });
    expect(sends()).toHaveLength(1);
  });
});

// ================================================================ weather check
describe("read-only weather check", () => {
  it("shows the forecast even when weather is off for the message (not included)", async () => {
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: false, hoursBefore: 4, includeWeather: false, units: "metric" }) } });
    const { preview: p } = await preview();
    expect(p.weather).toMatchObject({ reason: "INCLUDED", includedInMessage: false, forecast: { temperatureC: 20 } });
    expect(p.message!.html).not.toContain("°");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no confirmed location", async () => prisma.venue.update({ where: { id: "o-v" }, data: { weatherLocationConfirmedAt: null } }), "NO_LOCATION"],
    ["no venue", async () => prisma.match.update({ where: { id: "m" }, data: { venueId: null } }), "NO_VENUE"],
    ["no start time", async () => prisma.match.update({ where: { id: "m" }, data: { startTime: null } }), "NO_START_TIME"],
    ["provider not configured", async (): Promise<void> => setWeatherProviderForTests(null), "NOT_CONFIGURED"],
    ["provider returns nothing", async (): Promise<void> => void (forecast = null), "UNAVAILABLE"],
  ] as ReadonlyArray<readonly [string, () => Promise<unknown>, string]>)("%s → explained (%s); the update itself stays sendable", async (_n, change, reason) => {
    vi.stubEnv("WEATHERAPI_KEY", ""); // no real key: "not configured" really means none
    await change();
    const { preview: p } = await preview();
    expect(p.weather).toMatchObject({ reason, forecast: null, includedInMessage: false });
    expect(p.state).toBe("READY");
  });
});

// ================================================================ attendance summary (one shared calculation)
describe("attendance summary: the website, the preview and the sent message agree", () => {
  const TG_SECRET = "itest-webhook-secret";
  // Community "c": members p1, p2, p3 (active), p5 (INACTIVE). p4 is in the group but NOT a member.
  async function communityRoster() {
    await prisma.player.createMany({
      data: [
        { id: "p4", groupId: "o-g", firstName: "Outsider", lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3 },
        { id: "p5", groupId: "o-g", firstName: "Gone", lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: false },
      ],
    });
    await prisma.community.create({ data: { id: "c", groupId: "o-g", name: "Wednesdays" } });
    await prisma.communityPlayer.createMany({ data: ["p1", "p2", "p3", "p5"].map((playerId) => ({ groupId: "o-g", communityId: "c", playerId })) });
    await prisma.match.update({ where: { id: "m" }, data: { communityId: "c" } });
    await prisma.telegramUserLink.create({ data: { groupId: "o-g", userId: 5002n, playerId: "p2" } });
  }
  const workspace = async () => {
    const r = await matchRoute.GET(new Request("http://itest.local/"), ctx("m"));
    const body = (await r.json()) as { counts: { PLAYING: number; NOT_PLAYING: number; MAYBE: number; NO_RESPONSE: number }; rosterSize: number };
    return { ...body.counts, rosterSize: body.rosterSize };
  };
  const summaryOf = (html: string) => {
    const m = html.match(/👥 Attendance Summary \((\d+) players?\)\n✅ Playing: (\d+)\n❌ Not Playing: (\d+)\n🤔 Maybe: (\d+)\n⏳ Not Responded: (\d+)/);
    if (!m) throw new Error("no attendance summary in the message");
    const [roster, PLAYING, NOT_PLAYING, MAYBE, NO_RESPONSE] = m.slice(1).map(Number);
    return { PLAYING, NOT_PLAYING, MAYBE, NO_RESPONSE, rosterSize: roster };
  };
  const vote = (userId: number, optionIds: number[]) =>
    webhookRoute.POST(
      new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify({ update_id: 1, poll_answer: { poll_id: "poll-m", user: { id: userId, first_name: "T" }, option_ids: optionIds } }) }) as never
    );
  beforeEach(() => vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", TG_SECRET));

  it("eligible roster only (active members), each player once; counts add up; equal on the website, in the preview and in the sent message", async () => {
    await communityRoster();
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "o-g", playerId: "p4", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } }); // non-member
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "o-g", playerId: "p5", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } }); // inactive
    const expected = { PLAYING: 1, NOT_PLAYING: 0, MAYBE: 0, NO_RESPONSE: 2, rosterSize: 3 };
    expect(await workspace()).toEqual(expected);
    const { preview: p } = await preview();
    expect(summaryOf(p.message!.html)).toEqual(expected);
    expect((await send(p.token)).body.result).toBe("sent");
    expect(summaryOf(String(sends()[0].body.text))).toEqual(expected);
  });

  it("Telegram votes: a linked player's vote lowers Not Responded once; a duplicate event changes nothing; Playing → Maybe keeps the respondents; an unknown voter is never counted", async () => {
    await communityRoster();
    const before = await workspace();
    expect(before).toMatchObject({ NO_RESPONSE: 2, rosterSize: 3 });
    await vote(5002, [0]); // p2 → Playing
    expect(await workspace()).toMatchObject({ PLAYING: 2, NO_RESPONSE: 1, rosterSize: 3 });
    await vote(5002, [0]); // duplicate delivery of the same answer
    expect(await workspace()).toMatchObject({ PLAYING: 2, NO_RESPONSE: 1 });
    await vote(5002, [2]); // changes to Maybe: still a respondent
    expect(await workspace()).toMatchObject({ PLAYING: 1, MAYBE: 1, NO_RESPONSE: 1, rosterSize: 3 });
    await vote(9999, [1]); // a Telegram voter not linked to any player
    const after = await workspace();
    expect(after).toMatchObject({ PLAYING: 1, MAYBE: 1, NOT_PLAYING: 0, NO_RESPONSE: 1, rosterSize: 3 });
    expect(after.PLAYING + after.NOT_PLAYING + after.MAYBE + after.NO_RESPONSE).toBe(after.rosterSize);
    expect(summaryOf((await preview()).preview.message!.html)).toEqual(after);
  });

  it("organizer overrides and roster changes are reflected (override beats the player's answer; deactivated / removed players leave the total)", async () => {
    await communityRoster();
    await prisma.attendanceResponse.update({ where: { matchId_playerId: { matchId: "m", playerId: "p1" } }, data: { overrideStatus: "NOT_PLAYING", overrideAt: new Date() } });
    expect(await workspace()).toEqual({ PLAYING: 0, NOT_PLAYING: 1, MAYBE: 0, NO_RESPONSE: 2, rosterSize: 3 });
    await prisma.player.update({ where: { id: "p3" }, data: { isActive: false } });
    expect(await workspace()).toEqual({ PLAYING: 0, NOT_PLAYING: 1, MAYBE: 0, NO_RESPONSE: 1, rosterSize: 2 });
    await prisma.communityPlayer.deleteMany({ where: { communityId: "c", playerId: "p2" } });
    const w = await workspace();
    expect(w).toEqual({ PLAYING: 0, NOT_PLAYING: 1, MAYBE: 0, NO_RESPONSE: 0, rosterSize: 1 });
    expect(summaryOf((await preview()).preview.message!.html)).toEqual(w);
  });

  it("a match without a Community counts every active player of the group (website and message alike)", async () => {
    expect(await workspace()).toEqual({ PLAYING: 1, NOT_PLAYING: 0, MAYBE: 0, NO_RESPONSE: 2, rosterSize: 3 });
    expect(summaryOf((await preview()).preview.message!.html)).toEqual(await workspace());
  });

  it.each([
    ["a non-responder answers Not Playing (only Not Playing / Not Responded change)", async () => prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "o-g", playerId: "p2", participantStatus: "NOT_PLAYING", participantSource: "WEB", participantRespondedAt: new Date() } })],
    ["a player is deactivated (roster total changes)", async () => prisma.player.update({ where: { id: "p3" }, data: { isActive: false } })],
    ["a new player joins the roster", async () => prisma.player.create({ data: { id: "p9", groupId: "o-g", firstName: "New", lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3 } })],
  ] as const)("any attendance or roster change after the preview → refreshed preview required: %s", async (_n, change) => {
    const { preview: p } = await preview();
    await change();
    expect(await send(p.token)).toMatchObject({ status: 409, body: { result: "stale" } });
    expect(sends()).toHaveLength(0);
    const fresh = (await preview()).preview;
    expect(summaryOf(fresh.message!.html)).toEqual(await workspace());
    expect((await send(fresh.token)).body.result).toBe("sent");
    expect(String(sends()[0].body.text)).toBe(fresh.message!.html);
  });

  it("automatic and manual updates use the same format", async () => {
    await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: true, units: "imperial" }) } });
    const manualHtml = (await preview()).preview.message!.html;
    vi.useRealTimers();
    expect((await runMatchAutomation(at(-3 * H))).gameDayUpdates).toBe(1);
    expect(String(sends()[0].body.text)).toBe(manualHtml); // same instant, same facts → byte-identical
  });
});
