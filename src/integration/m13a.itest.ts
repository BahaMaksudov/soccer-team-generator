/**
 * M13A — REAL DATABASE (guarded local test DB only). Telegram is a stub (no real
 * calls) and email goes to the in-memory test outbox; nothing leaves the machine.
 *
 *   Phase 0 — signed-in website attendance (/me) is refused for TELEGRAM matches
 *             (409 TELEGRAM_MATCH), decided under the Match row lock.
 *   Group invitations — join links, join requests, manual approval.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as ownAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import { setOwnAttendance, TELEGRAM_MATCH_MESSAGE } from "@/lib/matches";
import { loadMyGames } from "@/lib/myGames";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { answerPersonal } from "@/lib/personalAttendance";
import { generateToken, hashToken } from "@/lib/secureToken";

export const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
let tgCalls = 0;
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown): Promise<Response> {
  if (String(url).startsWith("https://api.telegram.org/bot")) {
    tgCalls++;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
  }
  otherNetwork++;
  throw new Error("network access is forbidden in integration tests");
}

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://itest.local/api/x", { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const gm = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const own = (matchId: string, status: string) => call(ownAttendanceRoute.POST(json("POST", { status }), { params: Promise.resolve({ matchId }) }));
const row = (matchId: string, playerId: string) => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId, playerId } } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PersonalAttendanceLink","MessageDelivery","AttendanceResponse","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","Match","CommunityPlayer","Community","PlayerClaim","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: [
      ...["owner", "admin", "member", "player", "other", "free"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
      { id: "u-unverified", email: "unverified@example.test", name: "unverified", passwordHash: null, emailVerifiedAt: null },
    ],
  });
  await prisma.organization.createMany({
    data: [
      { id: "o", name: "Org", slug: "o", plan: "LEGACY" },
      { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" },
      { id: "of", name: "Free", slug: "of", plan: "FREE" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday Soccer", slug: "g", sportKey: "soccer", timezone: TZ, visibility: "LINK" },
      { id: "gx", organizationId: "o", name: "Second Group", slug: "gx", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other Group", slug: "g2", sportKey: "soccer", timezone: TZ },
      { id: "gf", organizationId: "of", name: "Free Group", slug: "gf", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
      { userId: "u-free", organizationId: "of", role: "OWNER" },
    ],
  });
  const P = (id: string, groupId: string, firstName: string, userId: string | null = null) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, userId });
  await prisma.player.createMany({ data: [P("p1", "g", "Pat", "u-player"), P("p2", "g", "Sam"), P("p3", "g", "Kim"), P("x1", "g2", "Xen", "u-other")] });
  await prisma.telegramUserLink.create({ data: { groupId: "g", userId: 111n, playerId: "p1" } });
}
const webMatch = (id: string, data: Record<string, unknown> = {}) => prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", ...data } });
async function telegramMatch(id: string, chatId = -100n) {
  const chat = await prisma.telegramChat.create({ data: { chatId, title: "Chat", groupId: "g" } });
  await prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", telegramChatId: chat.id } });
  await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId, messageId: 9n, question: "Playing?", optionsJson: "[]", pollDate: new Date("2099-06-03"), groupId: "g", matchId: id, kind: "ATTENDANCE" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
});
beforeEach(async () => {
  tgCalls = 0;
  await seed();
  signIn("player");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("M13A Phase 0 — signed-in website attendance is refused for Telegram matches", () => {
  it("website-only match: the signed-in player's own answer is recorded (WEB)", async () => {
    await webMatch("mw");
    expect(await own("mw", "PLAYING")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await row("mw", "p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "WEB" });
  });

  it("Telegram match (poll): 409 TELEGRAM_MATCH, nothing written", async () => {
    await telegramMatch("mt");
    expect(await own("mt", "PLAYING")).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH", error: TELEGRAM_MATCH_MESSAGE } });
    expect(await row("mt", "p1")).toBeNull();
  });

  it("Telegram match (connected chat, no poll yet): 409 too", async () => {
    const chat = await prisma.telegramChat.create({ data: { chatId: -300n, title: "C", groupId: "g" } });
    await webMatch("mc", { telegramChatId: chat.id });
    expect((await own("mc", "MAYBE")).body).toMatchObject({ code: "TELEGRAM_MATCH" });
    expect(await row("mc", "p1")).toBeNull();
  });

  it("the Telegram vote stays authoritative: a later website attempt changes nothing", async () => {
    await telegramMatch("mt");
    expect(await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mt", groupId: "g", telegramUserId: 111n, optionIds: [0], at: new Date() }))).toBe("recorded");
    expect((await own("mt", "NOT_PLAYING")).status).toBe(409);
    expect(await row("mt", "p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "TELEGRAM" });
  });

  it("/me: Telegram matches are poll-only; website-only matches keep their buttons", async () => {
    await webMatch("mw", { date: new Date("2099-06-01") });
    await telegramMatch("mt");
    const [profile] = await loadMyGames("u-player");
    expect(profile.upcoming.map((g) => [g.matchId, g.attendanceMode])).toEqual([
      ["mw", "web"],
      ["mt", "telegram"],
    ]);
  });

  it("stale page: /me loaded while web-only, then a poll is posted → the old buttons' request is refused", async () => {
    await webMatch("mw");
    expect((await loadMyGames("u-player"))[0].upcoming[0].attendanceMode).toBe("web");
    await prisma.telegramPoll.create({ data: { pollId: "late", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
    expect((await own("mw", "PLAYING")).body).toMatchObject({ code: "TELEGRAM_MATCH" });
    expect(await row("mw", "p1")).toBeNull();
  });

  it("race: a poll being inserted concurrently (uncommitted) — the website answer waits for it and is refused", async () => {
    await webMatch("mw");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const pollInserted = new Promise<void>((r) => (inserted = r));
    const posting = prisma.$transaction(
      async (tx) => {
        await tx.telegramPoll.create({ data: { pollId: "racing", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
        inserted();
        await gate; // hold the poll insert (and its FOR KEY SHARE on the Match row) open
      },
      { timeout: 20_000 }
    );
    await pollInserted;
    const answering = setOwnAttendance("u-player", "mw", "PLAYING");
    const early = await Promise.race([answering.then(() => "finished"), new Promise((r) => setTimeout(() => r("waiting"), 400))]);
    expect(early).toBe("waiting"); // blocked on the Match row lock
    release();
    await posting;
    expect(await answering).toBe("telegram");
    expect(await row("mw", "p1")).toBeNull();
  });

  it("race (M12B personal link): same guarantee", async () => {
    await webMatch("mw");
    const token = generateToken();
    await prisma.personalAttendanceLink.create({ data: { organizationId: "o", groupId: "g", matchId: "mw", playerId: "p2", tokenHash: hashToken(token) } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const pollInserted = new Promise<void>((r) => (inserted = r));
    const posting = prisma.$transaction(
      async (tx) => {
        await tx.telegramPoll.create({ data: { pollId: "racing2", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
        inserted();
        await gate;
      },
      { timeout: 20_000 }
    );
    await pollInserted;
    const answering = answerPersonal(token, "PLAYING");
    await new Promise((r) => setTimeout(r, 300));
    release();
    await posting;
    expect(await answering).toEqual({ ok: false, reason: "telegram" });
    expect(await row("mw", "p2")).toBeNull();
  });

  it("organizer override still works on a Telegram match", async () => {
    await telegramMatch("mt");
    signIn("owner");
    expect((await call(overrideRoute.POST(json("POST", { playerId: "p1", status: "NOT_PLAYING" }), gm("mt")))).status).toBe(200);
    expect(await row("mt", "p1")).toMatchObject({ overrideStatus: "NOT_PLAYING" });
  });

  it("cross-organization: a player of another organization gets 404; signed out 401", async () => {
    await webMatch("mw");
    signIn("other");
    expect((await own("mw", "PLAYING")).status).toBe(404);
    signIn(null);
    expect((await own("mw", "PLAYING")).status).toBe(401);
    expect(await prisma.attendanceResponse.count()).toBe(0);
    expect(tgCalls).toBe(0);
    expect(otherNetwork).toBe(0);
  });
});
