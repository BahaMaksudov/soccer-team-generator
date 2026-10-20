/**
 * M12B — one attendance workflow per Match, REAL DATABASE (guarded local test DB
 * only). Telegram is a stub (no real calls); nothing leaves the machine.
 *
 *   - website-only matches: personal attendance links (one Player, one Match);
 *   - Telegram matches: the poll only (no personal links);
 *   - one closure path: attendance + poll closed together, ONE notice ever;
 *   - concurrency / stale answers never overwrite newer ones.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as linksRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/personal-links/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as attendViewRoute from "@/app/api/attend/route";
import * as attendAnswerRoute from "@/app/api/attend/answer/route";
import * as shareAnswerRoute from "@/app/api/share/match/attendance/route";
import { answerPersonal, personalView, LINK_ANSWER_LIMIT } from "@/lib/personalAttendance";
import { attendanceMode, closeMatchAttendance } from "@/lib/attendanceClosure";
import { recordParticipantResponse } from "@/lib/attendance";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { runMatchAutomation } from "@/lib/matchAutomation";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";

// ------------------------------------------------------------ Telegram stub
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let stopPollMode: "ok" | "ambiguous" = "ok";
const isNotice = (c: { method: string; body: Record<string, unknown> }) => c.method === "sendMessage" && String(c.body.text ?? "").startsWith("✅ Poll is closed");
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  if (method === "stopPoll" && stopPollMode === "ambiguous") throw new TypeError("fetch failed");
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
}

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://itest.local/api/x", { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const sameOrigin = { Origin: "http://itest.local" };
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const gm = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const links = (matchId: string, body: unknown, org?: string, group?: string) => call(linksRoute.POST(json("POST", body), gm(matchId, org, group)));
const issue = async (matchId: string, playerIds?: string[]) => {
  const r = await links(matchId, { action: "issue", playerIds });
  expect(r.status).toBe(200);
  return new Map((r.body.links as Array<{ playerId: string; path: string }>).map((l) => [l.playerId, l.path.split("#")[1]]));
};
const row = (matchId: string, playerId: string) => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId, playerId } } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PersonalAttendanceLink","MessageDelivery","AttendanceResponse","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "member", "other", "free"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({
    data: [
      { id: "o", name: "Org", slug: "o", plan: "LEGACY" },
      { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" },
      // An expired trial → effectively Free: polls can be CLOSED, but nothing is announced.
      { id: "of", name: "Free", slug: "of", plan: "FREE", trialStartedAt: new Date("2025-01-01T00:00:00Z"), trialEndsAt: new Date("2025-01-15T00:00:00Z") },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "G", slug: "g", sportKey: "soccer", timezone: TZ, visibility: "LINK" },
      { id: "g2", organizationId: "o2", name: "G2", slug: "g2", sportKey: "soccer", timezone: TZ },
      { id: "gf", organizationId: "of", name: "GF", slug: "gf", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
      { userId: "u-free", organizationId: "of", role: "OWNER" },
    ],
  });
  const P = (id: string, groupId: string, firstName: string) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER" as const, rating: "GOOD" as const, stamina: 3 });
  await prisma.player.createMany({ data: [P("p1", "g", "Ann"), P("p2", "g", "Bob"), P("p3", "g", "Cy"), P("x1", "g2", "Xen"), P("f1", "gf", "Fay")] });
  await prisma.telegramUserLink.createMany({ data: [{ groupId: "g", userId: 111n, playerId: "p1" }, { groupId: "gf", userId: 222n, playerId: "f1" }] });
}
/** A website-only match (no Telegram group, no poll), far in the future. */
const webMatch = (id: string, data: Record<string, unknown> = {}) => prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", ...data } });
/** A Telegram match with an open attendance poll. */
async function telegramMatch(id: string, groupId = "g", chatId = -100n) {
  const chat = await prisma.telegramChat.create({ data: { chatId, title: "Chat", groupId } });
  await prisma.match.create({ data: { id, groupId, date: new Date("2099-06-03"), startTime: "21:00", telegramChatId: chat.id } });
  await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId, messageId: 9n, question: "Playing?", optionsJson: "[]", pollDate: new Date("2099-06-03"), groupId, matchId: id, kind: "ATTENDANCE" } });
}
const noticeRows = () => prisma.messageDelivery.findMany({ where: { eventType: "POLL_CLOSED_NOTICE" } });

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("ATTENDANCE_DEADLINE_NOTICE", "");
});
beforeEach(async () => {
  tgCalls = [];
  stopPollMode = "ok";
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("M12B — attendance mode (one workflow per match)", () => {
  it("web without Telegram; telegram with a poll or a connected chat (plan permitting)", async () => {
    await webMatch("mw");
    await telegramMatch("mt");
    expect(await attendanceMode("g", "mw")).toBe("web");
    expect(await attendanceMode("g", "mt")).toBe("telegram");
    expect(await attendanceMode("g2", "mw")).toBeNull(); // foreign group
    // A connected chat but no poll yet → telegram (LEGACY); disconnected → web.
    const chat = await prisma.telegramChat.create({ data: { chatId: -300n, title: "C", groupId: "g" } });
    await webMatch("mc", { telegramChatId: chat.id });
    expect(await attendanceMode("g", "mc")).toBe("telegram");
    await prisma.telegramChat.update({ where: { id: chat.id }, data: { disconnectedAt: new Date() } });
    expect(await attendanceMode("g", "mc")).toBe("web");
    // Free (expired trial) with a connected chat and no poll → web (no Telegram workflow available).
    const fchat = await prisma.telegramChat.create({ data: { chatId: -400n, title: "F", groupId: "gf" } });
    await prisma.match.create({ data: { id: "mf", groupId: "gf", date: new Date("2099-06-03"), telegramChatId: fchat.id } });
    expect(await attendanceMode("gf", "mf")).toBe("web");
  });
});

describe("M12B — personal links (organizer)", () => {
  it("issue → only hashes stored; GET never exposes tokens; MEMBER / foreign owner → 404; nothing sent", async () => {
    await webMatch("m1");
    const tokens = await issue("m1");
    expect([...tokens.keys()].sort()).toEqual(["p1", "p2", "p3"]);
    const stored = await prisma.personalAttendanceLink.findMany({ where: { matchId: "m1" } });
    expect(stored).toHaveLength(3);
    for (const s of stored) {
      expect(s.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect([...tokens.values()]).not.toContain(s.tokenHash);
      expect(s).toMatchObject({ organizationId: "o", groupId: "g", createdByUserId: "u-owner", revokedAt: null });
    }
    const view = await call(linksRoute.GET(json("GET"), gm("m1")));
    expect(view.status).toBe(200);
    expect(view.headers.get("Cache-Control")).toBe("no-store");
    const text = JSON.stringify(view.body);
    for (const t of tokens.values()) expect(text).not.toContain(t);
    expect(view.body).toMatchObject({ mode: "web", state: "open" });

    signIn("member");
    expect((await links("m1", { action: "issue" })).status).toBe(404);
    signIn("other");
    expect((await links("m1", { action: "issue" }, "o2", "g2")).status).toBe(404); // not their match
    expect((await links("m1", { action: "issue" })).status).toBe(404); // not their org
    expect(tgCalls).toEqual([]);
    expect(otherNetwork).toBe(0);
  });

  it("refused for a Telegram match, a closed / canceled match, and players not on the roster", async () => {
    await telegramMatch("mt");
    expect(await links("mt", { action: "issue" })).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH" } });
    await webMatch("mc", { attendanceClosedAt: new Date() });
    expect(await links("mc", { action: "issue" })).toMatchObject({ status: 409, body: { code: "NOT_OPEN" } });
    await webMatch("mx", { status: "CANCELED" });
    expect(await links("mx", { action: "issue" })).toMatchObject({ status: 409, body: { code: "NOT_OPEN" } });
    await webMatch("m1");
    expect(await links("m1", { action: "issue", playerIds: ["x1"] })).toMatchObject({ status: 409, body: { code: "NOT_ON_ROSTER" } });
    expect(await prisma.personalAttendanceLink.count()).toBe(0);
  });

  it("regenerate revokes the previous link; revoke stops a link", async () => {
    await webMatch("m1");
    const first = (await issue("m1", ["p1"])).get("p1")!;
    const second = (await issue("m1", ["p1"])).get("p1")!;
    expect(second).not.toBe(first);
    expect(await answerPersonal(first, "PLAYING")).toEqual({ ok: false, reason: "revoked" });
    expect((await personalView(first))?.state).toBe("revoked");
    expect(await answerPersonal(second, "PLAYING")).toMatchObject({ ok: true, status: "PLAYING" });
    expect(await links("m1", { action: "revoke", playerId: "p1" })).toMatchObject({ status: 200 });
    expect(await answerPersonal(second, "NOT_PLAYING")).toEqual({ ok: false, reason: "revoked" });
    expect(await links("m1", { action: "revoke", playerId: "p1" })).toMatchObject({ status: 404 });
    expect((await row("m1", "p1"))?.participantStatus).toBe("PLAYING");
  });
});

describe("M12B — personal links (player)", () => {
  it("view shows only the link's own player; answers are recorded as PERSONAL_LINK and can change until the deadline", async () => {
    const deadline = new Date("2099-06-03T22:00:00Z"); // 18:00 EDT
    await webMatch("m1", { attendanceDeadlineAt: deadline, locationName: "Field 3" });
    const t = await issue("m1");
    const v = await call(attendViewRoute.POST(json("POST", { token: t.get("p2") })));
    expect(v.status).toBe(200);
    expect(v.headers.get("Cache-Control")).toBe("no-store");
    expect(v.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(v.body).toMatchObject({ state: "open", playerName: "Bob", match: { date: "2099-06-03", venue: "Field 3", timeZone: TZ, kickoffLabel: "9:00 PM EDT", deadline: deadline.toISOString() } });
    const text = JSON.stringify(v.body);
    for (const other of ["Ann", "Cy", "p1", "p2", "p3"]) expect(text).not.toContain(other);

    const ans = (status: string, token = t.get("p2")) => call(attendAnswerRoute.POST(json("POST", { token, status }, sameOrigin)));
    expect(await ans("PLAYING")).toMatchObject({ status: 200, body: { ok: true, status: "PLAYING" } });
    expect(await ans("MAYBE")).toMatchObject({ status: 200, body: { status: "MAYBE" } });
    expect(await row("m1", "p2")).toMatchObject({ participantStatus: "MAYBE", participantSource: "PERSONAL_LINK" });
    // Only p2 changed: the browser cannot pick the player.
    expect(await prisma.attendanceResponse.count({ where: { matchId: "m1" } })).toBe(1);
    // After the deadline the link "expires".
    expect(await answerPersonal(t.get("p2"), "PLAYING", new Date(deadline.getTime() + 1000))).toEqual({ ok: false, reason: "closed" });
    expect((await personalView(t.get("p2"), new Date(deadline.getTime() + 1000)))?.state).toBe("closed");
  });

  it("closed / canceled / Telegram-mode / bad tokens: clear outcomes, generic 404 for anything invalid", async () => {
    await webMatch("m1");
    const t = (await issue("m1", ["p1"])).get("p1")!;
    const ans = (body: unknown, headers = sameOrigin) => call(attendAnswerRoute.POST(json("POST", body, headers)));
    expect((await ans({ token: t, status: "PLAYING" }, {} as typeof sameOrigin)).status).toBe(403); // cross-site
    expect(await ans({ token: t, status: "BOGUS" })).toMatchObject({ status: 400 });
    expect(await ans({ token: "x".repeat(43), status: "PLAYING" })).toMatchObject({ status: 404, body: { code: "invalid" } });
    expect(await call(attendViewRoute.POST(json("POST", { token: "nope" })))).toMatchObject({ status: 404, body: { error: "This link is not valid." } });

    await prisma.match.update({ where: { id: "m1" }, data: { attendanceClosedAt: new Date() } });
    expect(await ans({ token: t, status: "PLAYING" })).toMatchObject({ status: 409, body: { code: "closed" } });
    await prisma.match.update({ where: { id: "m1" }, data: { attendanceClosedAt: null, status: "CANCELED" } });
    expect(await ans({ token: t, status: "PLAYING" })).toMatchObject({ status: 409, body: { code: "canceled" } });
    // A poll added later makes it a Telegram match: the link stops accepting answers.
    await prisma.match.update({ where: { id: "m1" }, data: { status: "SCHEDULED" } });
    await prisma.telegramPoll.create({ data: { pollId: "late-poll", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "m1", kind: "ATTENDANCE" } });
    expect(await ans({ token: t, status: "PLAYING" })).toMatchObject({ status: 409, body: { code: "telegram" } });
    // A deactivated player's link is invalid (generic).
    await prisma.telegramPoll.delete({ where: { pollId: "late-poll" } });
    await prisma.player.update({ where: { id: "p1" }, data: { isActive: false } });
    expect(await ans({ token: t, status: "PLAYING" })).toMatchObject({ status: 404 });
    expect(await row("m1", "p1")).toBeNull();
  });

  it("the organizer override keeps precedence over a later personal-link answer", async () => {
    await webMatch("m1");
    const t = (await issue("m1", ["p1"])).get("p1")!;
    expect((await call(overrideRoute.POST(json("POST", { playerId: "p1", status: "NOT_PLAYING" }), gm("m1")))).status).toBe(200);
    expect(await answerPersonal(t, "PLAYING")).toEqual({ ok: true, status: "PLAYING", setByOrganizer: true });
    expect(await row("m1", "p1")).toMatchObject({ overrideStatus: "NOT_PLAYING", participantStatus: "PLAYING", participantSource: "PERSONAL_LINK" });
    expect((await personalView(t))?.current).toEqual({ status: "NOT_PLAYING", setByOrganizer: true });
  });

  it("per-link database rate limit", async () => {
    await webMatch("m1");
    const t = (await issue("m1", ["p1"])).get("p1")!;
    const now = new Date();
    for (let i = 0; i < LINK_ANSWER_LIMIT.max; i++) expect((await answerPersonal(t, i % 2 ? "PLAYING" : "MAYBE", new Date(now.getTime() + i))).ok).toBe(true);
    expect(await answerPersonal(t, "PLAYING", new Date(now.getTime() + 100))).toEqual({ ok: false, reason: "rate_limited" });
    // A new window opens after windowMs.
    expect((await answerPersonal(t, "PLAYING", new Date(now.getTime() + LINK_ANSWER_LIMIT.windowMs + 1))).ok).toBe(true);
  });

  it("the shared match link is view-only: answering is refused (410) and changes nothing", async () => {
    await webMatch("m1");
    const r = await call(shareAnswerRoute.POST());
    expect(r).toMatchObject({ status: 410, body: { code: "MATCH_LINK_READ_ONLY" } });
    expect(await prisma.attendanceResponse.count()).toBe(0);
  });
});

describe("M12B — data integrity", () => {
  it("concurrent answers for one player: the newest answer always wins, never an older one", async () => {
    await webMatch("m1");
    const base = Date.now();
    const writes = Array.from({ length: 12 }, (_, i) => ({ at: new Date(base + i * 1000), status: (["PLAYING", "MAYBE", "NOT_PLAYING"] as const)[i % 3] }));
    // Fire in reverse order, all at once.
    await Promise.all(
      [...writes].reverse().map((w) => prisma.$transaction((tx) => recordParticipantResponse(tx, { matchId: "m1", groupId: "g", playerId: "p1", status: w.status, source: "PERSONAL_LINK", at: w.at })))
    );
    const last = writes[writes.length - 1];
    expect(await row("m1", "p1")).toMatchObject({ participantStatus: last.status, participantRespondedAt: last.at });
  });

  it("a stale (older) Telegram event never overwrites a newer answer", async () => {
    await telegramMatch("mt");
    const t0 = new Date();
    await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mt", groupId: "g", telegramUserId: 111n, optionIds: [0], at: new Date(t0.getTime() + 5000) }));
    const stale = await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mt", groupId: "g", telegramUserId: 111n, optionIds: [1], at: t0 }));
    expect(stale).toBe("stale");
    expect(await row("mt", "p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "TELEGRAM" });
  });
});

describe("M12B — unified closure", () => {
  it("Close attendance closes the poll too and sends ONE notice; closing again sends none", async () => {
    await telegramMatch("mt");
    const r1 = await call(closeRoute.POST(json("POST", { closed: true }), gm("mt")));
    expect(r1).toMatchObject({ status: 200, body: { ok: true, attendanceClosed: true, notices: ["sent"] } });
    expect(String(r1.body.message)).toContain("Closure notice sent.");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "mt" } })).attendanceClosedAt).not.toBeNull();
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-mt" } })).isClosed).toBe(true);
    expect(tgCalls.map((c) => c.method)).toEqual(["stopPoll", "sendMessage"]);
    expect(tgCalls.filter(isNotice)).toHaveLength(1);
    tgCalls = [];
    expect(await call(closeRoute.POST(json("POST", { closed: true }), gm("mt")))).toMatchObject({ status: 200, body: { notices: ["exists"] } });
    expect(tgCalls).toEqual([]);
    expect(await noticeRows()).toHaveLength(1);
  });

  it("concurrent closes of the same match send exactly one notice", async () => {
    await telegramMatch("mt");
    await Promise.all([1, 2, 3].map(() => closeMatchAttendance({ groupId: "g", matchId: "mt", userId: "u-owner", notify: true })));
    expect(tgCalls.filter(isNotice)).toHaveLength(1);
    expect(await noticeRows()).toHaveLength(1);
  });

  it("an unconfirmed stop sends no notice and leaves the poll open locally; a later close announces once", async () => {
    await telegramMatch("mt");
    stopPollMode = "ambiguous";
    const r = await closeMatchAttendance({ groupId: "g", matchId: "mt", userId: "u-owner", notify: true });
    expect(r).toMatchObject({ attendance: "closed_now", status: "uncertain", polls: [{ notice: "not_closed" }] });
    expect(tgCalls.filter(isNotice)).toHaveLength(0);
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-mt" } })).isClosed).toBe(false);
    stopPollMode = "ok";
    expect(await closeMatchAttendance({ groupId: "g", matchId: "mt", userId: "u-owner", notify: true })).toMatchObject({ attendance: "already_closed", status: "closed", polls: [{ notice: "sent" }] });
    expect(tgCalls.filter(isNotice)).toHaveLength(1);
  });

  it("Free / expired trial: attendance and the poll close, but no notice is posted", async () => {
    await telegramMatch("mf", "gf", -500n);
    const r = await closeMatchAttendance({ groupId: "gf", matchId: "mf", userId: "u-free", notify: true });
    expect(r).toMatchObject({ attendance: "closed_now", status: "closed", polls: [{ close: "closed_now", notice: "not_in_plan" }] });
    expect(tgCalls.map((c) => c.method)).toEqual(["stopPoll"]);
    expect(await noticeRows()).toHaveLength(0);
  });

  it("the deadline (automation) closes attendance + poll with NO notice while ATTENDANCE_DEADLINE_NOTICE is off", async () => {
    await telegramMatch("mt");
    await prisma.match.update({ where: { id: "mt" }, data: { attendanceDeadlineAt: new Date("2099-06-03T22:00:00Z") } });
    await runMatchAutomation(new Date("2099-06-03T22:05:00Z"));
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "mt" } })).attendanceClosedAt).not.toBeNull();
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-mt" } })).isClosed).toBe(true);
    expect(tgCalls.filter(isNotice)).toHaveLength(0);
    expect(await noticeRows()).toHaveLength(0);
  });

  it("a website-only match closes without any Telegram call; personal links stop working", async () => {
    await webMatch("m1");
    const t = (await issue("m1", ["p1"])).get("p1")!;
    expect(await call(closeRoute.POST(json("POST", { closed: true }), gm("m1")))).toMatchObject({ status: 200, body: { ok: true, notices: [] } });
    expect(tgCalls).toEqual([]);
    expect(await answerPersonal(t, "PLAYING")).toEqual({ ok: false, reason: "closed" });
  });
});
