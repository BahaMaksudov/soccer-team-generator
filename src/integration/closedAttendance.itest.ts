/**
 * UI-4B — closed attendance is READ-ONLY, enforced server-side on every path
 * that can change an individual attendance answer: organizer override / clear
 * (OWNER, ADMIN), a player's own web answer, a Telegram poll answer, and the
 * Telegram sync. Closing / reopening never modifies existing answers or
 * overrides. Direct route calls (as a manual API request would make).
 *
 * Guarded local TEST database only; global fetch is a counting guard.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as syncRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/sync/route";
import * as selfAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const req = (body: unknown) => new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const gm = (matchId: string, t = A) => ({ params: Promise.resolve({ ...t, matchId }) });
const self = (matchId: string, status: string) => selfAttendanceRoute.POST(req({ status }), { params: Promise.resolve({ matchId }) });
const override = (playerId: string, status: string | null, matchId = "m1", t = A) => overrideRoute.POST(req({ playerId, status }), gm(matchId, t));
const setClosed = (closed: boolean, matchId = "m1") => closeRoute.POST(req({ closed }), gm(matchId));

let networkCalls = 0;
const originalFetch = global.fetch;
const signIn = async (email: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email } };
};
const rows = async (matchId = "m1") =>
  JSON.stringify(
    await prisma.attendanceResponse.findMany({
      where: { matchId },
      orderBy: { playerId: "asc" },
      select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true, overrideByUserId: true },
    })
  );
const row = (playerId: string, matchId = "m1") => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId, playerId } } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: ["owner", "admin", "member", "other-owner"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
  });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "A", slug: "org-a" }, { id: "org-b", name: "B", slug: "org-b" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC" },
      { id: "gb", organizationId: "org-b", name: "Group B", slug: "group-b", sportKey: "soccer", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-admin", organizationId: "org-a", role: "ADMIN" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other-owner", organizationId: "org-b", role: "OWNER" },
    ],
  });
  await prisma.player.createMany({
    data: [
      { id: "p1", groupId: "ga", userId: "u-member", firstName: "Mem", lastName: "Ber", position: "DEFENDER", rating: "GOOD", stamina: 3 },
      { id: "p2", groupId: "ga", firstName: "Two", lastName: "P", position: "FORWARD", rating: "GOOD", stamina: 3 },
      { id: "p3", groupId: "ga", firstName: "Three", lastName: "P", position: "FORWARD", rating: "GOOD", stamina: 3 },
    ],
  });
  await prisma.match.createMany({ data: [{ id: "m1", groupId: "ga", date: new Date("2099-06-01T00:00:00Z") }, { id: "mb", groupId: "gb", date: new Date("2099-06-01T00:00:00Z") }] });
  await prisma.telegramUserLink.create({ data: { groupId: "ga", userId: 7002n, playerId: "p2" } });
  await prisma.telegramPoll.create({ data: { pollId: "poll-1", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga", matchId: "m1", kind: "ATTENDANCE" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});
beforeEach(async () => {
  session = null;
  await seed();
});
afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
  expect(networkCalls).toBe(0);
});

const CLOSED = { error: "Attendance is closed. Reopen attendance to make changes.", code: "ATTENDANCE_CLOSED" };

describe("organizer attendance (OWNER / ADMIN)", () => {
  it.each(["owner", "admin"])("1/2: %s can set and clear overrides while OPEN", async (who) => {
    await signIn(`${who}@example.test`);
    expect((await override("p2", "PLAYING")).status).toBe(200);
    expect(await row("p2")).toMatchObject({ overrideStatus: "PLAYING" });
    expect((await override("p2", null)).status).toBe(200);
    expect(await row("p2")).toMatchObject({ overrideStatus: null });
  });

  it.each(["owner", "admin"])("3/4/5: %s cannot set Playing / Maybe / Not playing or clear an override while CLOSED (409, nothing changes)", async (who) => {
    await signIn(`${who}@example.test`);
    expect((await override("p2", "PLAYING")).status).toBe(200);
    expect((await setClosed(true)).status).toBe(200);
    const before = await rows();
    for (const status of ["PLAYING", "MAYBE", "NOT_PLAYING", null]) {
      const res = await override("p2", status);
      expect(res.status, String(status)).toBe(409);
      expect(await res.json()).toEqual(CLOSED);
      expect((await override("p3", status)).status, `p3 ${status}`).toBe(409);
    }
    expect(await rows()).toBe(before);
  });

  it("8: MEMBER still cannot use the organizer override (generic 404, open or closed)", async () => {
    await signIn("member@example.test");
    expect((await override("p2", "PLAYING")).status).toBe(404);
    await signIn("owner@example.test");
    await setClosed(true);
    await signIn("member@example.test");
    const res = await override("p2", "PLAYING");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" }); // no closed-state leak to MEMBER
    expect((await setClosed(false)).status).toBe(404);
  });

  it("13: closing and 9: reopening never modify existing answers or overrides; 10: changes work again after reopening", async () => {
    await signIn("member@example.test");
    expect((await self("m1", "MAYBE")).status).toBe(200);
    await signIn("owner@example.test");
    expect((await override("p2", "NOT_PLAYING")).status).toBe(200);
    const before = await rows();
    expect((await setClosed(true)).status).toBe(200);
    expect(await rows()).toBe(before);
    expect((await setClosed(false)).status).toBe(200);
    expect(await rows()).toBe(before);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m1" } })).attendanceClosedAt).toBeNull();
    for (const who of ["owner", "admin"]) {
      await signIn(`${who}@example.test`);
      expect((await override("p3", "PLAYING")).status).toBe(200);
      expect((await override("p2", null)).status).toBe(200);
    }
    expect(await row("p3")).toMatchObject({ overrideStatus: "PLAYING" });
    expect(await row("p2")).toMatchObject({ overrideStatus: null });
  });

  it("12: another Organization stays rejected (generic 404) — open or closed", async () => {
    await signIn("other-owner@example.test");
    expect((await override("p2", "PLAYING")).status).toBe(404);
    expect((await setClosed(true)).status).toBe(404);
    await signIn("owner@example.test");
    await setClosed(true);
    await signIn("other-owner@example.test");
    const res = await override("p2", "PLAYING");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    // and A's owner cannot touch B's Match through A's URL or B's URL
    await signIn("owner@example.test");
    expect((await override("p2", "PLAYING", "mb")).status).toBe(404);
    expect((await override("p2", "PLAYING", "mb", B)).status).toBe(404);
  });
});

describe("player self-attendance (claimed Player)", () => {
  it("6: works while OPEN; 7: rejected while CLOSED (409, nothing changes); 11: works again after reopening", async () => {
    await signIn("member@example.test");
    expect((await self("m1", "PLAYING")).status).toBe(200);
    expect(await row("p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "WEB" });

    await signIn("owner@example.test");
    await setClosed(true);
    await signIn("member@example.test");
    const before = await rows();
    const res = await self("m1", "NOT_PLAYING");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CLOSED);
    expect(await rows()).toBe(before);

    await signIn("owner@example.test");
    await setClosed(false);
    await signIn("member@example.test");
    expect((await self("m1", "NOT_PLAYING")).status).toBe(200);
    expect(await row("p1")).toMatchObject({ participantStatus: "NOT_PLAYING", participantSource: "WEB" });
  });

  it("a user without a claimed Player in the Match's Group still gets the generic 404 (closed state is not revealed)", async () => {
    await signIn("owner@example.test");
    await setClosed(true);
    const res = await self("m1", "PLAYING"); // owner has no claimed Player
    expect(res.status).toBe(404);
  });
});

describe("Telegram paths", () => {
  it("a Telegram answer while CLOSED does not change attendance; after reopening it records normally", async () => {
    await signIn("owner@example.test");
    await setClosed(true);
    const answer = (opts: number[]) => prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "m1", groupId: "ga", telegramUserId: 7002n, optionIds: opts, at: new Date() }));
    expect(await answer([0])).toBe("closed");
    expect(await row("p2")).toBeNull();
    await setClosed(false);
    expect(await answer([0])).toBe("recorded");
    expect(await row("p2")).toMatchObject({ participantStatus: "PLAYING", participantSource: "TELEGRAM" });
  });

  it("explicit Telegram sync is rejected while CLOSED and works after reopening", async () => {
    await prisma.telegramPollAnswer.create({ data: { pollId: "poll-1", userId: 7002n, optionIdsJson: "[2]", groupId: "ga" } });
    await signIn("admin@example.test");
    await setClosed(true);
    const res = await syncRoute.POST(req({}), gm("m1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CLOSED);
    expect(await row("p2")).toBeNull();
    await setClosed(false);
    const ok = await syncRoute.POST(req({}), gm("m1"));
    expect(await ok.json()).toMatchObject({ ok: true, recorded: 1 });
    expect(await row("p2")).toMatchObject({ participantStatus: "MAYBE", participantSource: "TELEGRAM" });
  });
});
