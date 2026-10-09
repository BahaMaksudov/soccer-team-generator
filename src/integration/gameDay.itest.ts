/**
 * UI-4 — REAL-DATABASE tests for the organizer Overview / Matches read model
 * and the authorization boundaries the redesigned game-day screens rely on.
 *
 * Guarded local TEST database only. Real Prisma, real route handlers and
 * tenant resolver; only NextAuth's session lookup is mocked. global fetch is
 * a counting guard: no Telegram / OpenAI / email call can happen.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { loadGroupOverview } from "@/lib/groupOverview";
import { loadMatchForViewer } from "@/lib/matchPage";
import { todayUtcYmd } from "@/lib/matchLifecycle";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as matchChatRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/telegram-chat/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const gm = (x: typeof A, matchId: string) => ({ params: Promise.resolve({ ...x, matchId }) });
const g = (x: typeof A) => ({ params: Promise.resolve(x) });
const json = (body: unknown) => new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const dayOffset = (n: number) => {
  const d = new Date(`${todayUtcYmd()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

let networkCalls = 0;
const originalFetch = global.fetch;

const as = async (email: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email } };
};
const contextFor = async (email: string, slugs = A) => {
  await as(email);
  return requireTenantContextForSlugs(slugs);
};

const TEAMS = JSON.stringify([
  { teamNumber: 1, players: [{ id: "p1", firstName: "Ann", lastName: "One", position: "DEFENDER" }, { id: "p2", firstName: "Bo", lastName: "Two", position: "FORWARD" }] },
  { teamNumber: 2, players: [{ id: "p3", firstName: "Cy", lastName: "Three", position: "DEFENDER" }, { id: "p4", firstName: "Di", lastName: "Four", position: "FORWARD" }] },
]);

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: [
      { id: "u-owner", email: "owner@example.test", name: "Owner", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-member", email: "member@example.test", name: "Member", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-other", email: "other@example.test", name: "Other", passwordHash: null, emailVerifiedAt: VERIFIED },
    ],
  });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "Org A", slug: "org-a", plan: "LEGACY" }, { id: "org-b", name: "Org B", slug: "org-b", plan: "LEGACY" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC", visibility: "PUBLIC" },
      { id: "gb", organizationId: "org-b", name: "Group B", slug: "group-b", sportKey: "soccer", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other", organizationId: "org-b", role: "OWNER" },
    ],
  });
  await prisma.player.createMany({
    data: [
      { id: "p1", groupId: "ga", firstName: "Ann", lastName: "One", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 },
      { id: "p2", groupId: "ga", firstName: "Bo", lastName: "Two", position: "FORWARD", rating: "GOOD", stamina: 2 },
      { id: "p3", groupId: "ga", firstName: "Cy", lastName: "Three", position: "DEFENDER", rating: "FAIR", stamina: 1 },
      { id: "p4", groupId: "ga", firstName: "Di", lastName: "Four", position: "FORWARD", rating: "VERY_GOOD", stamina: 4 },
      { id: "p5", groupId: "ga", firstName: "Ex", lastName: "Inactive", position: "FORWARD", rating: "GOOD", stamina: 3, isActive: false },
      { id: "pb", groupId: "gb", firstName: "Zed", lastName: "B", position: "FORWARD", rating: "GOOD", stamina: 3 },
    ],
  });
  await prisma.match.createMany({
    data: [
      { id: "m-next", groupId: "ga", date: dayOffset(3), startTime: "19:00", locationName: "Field 2" },
      { id: "m-later", groupId: "ga", date: dayOffset(10) },
      { id: "m-past-result", groupId: "ga", date: dayOffset(-2) },
      { id: "m-done", groupId: "ga", date: dayOffset(-9), status: "COMPLETED" },
      { id: "m-canceled", groupId: "ga", date: dayOffset(-5), status: "CANCELED" },
      { id: "m-b", groupId: "gb", date: dayOffset(1) },
    ],
  });
  await prisma.attendanceResponse.createMany({
    data: [
      { matchId: "m-next", groupId: "ga", playerId: "p1", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() },
      { matchId: "m-next", groupId: "ga", playerId: "p2", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date() },
      { matchId: "m-next", groupId: "ga", playerId: "p3", participantStatus: "MAYBE", participantSource: "WEB", participantRespondedAt: new Date() },
    ],
  });
  for (const [id, matchId, d] of [["tg-1", "m-past-result", -2], ["tg-2", "m-done", -9]] as const) {
    await prisma.teamGeneration.create({ data: { id, groupId: "ga", matchId, date: dayOffset(d), teamsJson: TEAMS } });
  }
  await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m-past-result", scoresJson: JSON.stringify([{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 2 }]) } });
  await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m-done", scoresJson: JSON.stringify([{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 4 }]), publishedAt: new Date() } });
  await prisma.matchMvp.create({ data: { groupId: "ga", matchId: "m-done", winnerPlayerIds: ["p1"], method: "ORGANIZER_SELECTION", selectedPlayerId: "p1", publishedAt: new Date() } });
  await prisma.matchRecap.create({ data: { groupId: "ga", matchId: "m-done", content: "Great game.", source: "DETERMINISTIC", publishedAt: new Date() } });
  await prisma.messageDelivery.create({
    data: { groupId: "ga", matchId: "m-done", eventType: "MATCH_SUMMARY_POSTED", channel: "TELEGRAM", destination: "-100", contentHash: "h", status: "SENT", claimedAt: new Date(), sentAt: new Date() },
  });
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

describe("Overview read model (real data only)", () => {
  it("next Match = earliest upcoming; real attendance counts of ACTIVE players; next step derived from state", async () => {
    const o = await loadGroupOverview(await contextFor("owner@example.test"));
    expect(o.canManage).toBe(true);
    expect(o.activePlayers).toBe(4);
    expect(o.upcoming.map((m) => m.id)).toEqual(["m-next", "m-later"]);
    expect(o.past.map((m) => m.id)).toEqual(["m-past-result", "m-canceled", "m-done"]); // most recent first
    expect(o.focus?.kind).toBe("next");
    expect(o.focus?.match.id).toBe("m-next");
    expect(o.focus?.counts).toEqual({ PLAYING: 2, MAYBE: 1, NOT_PLAYING: 0, NO_RESPONSE: 1 });
    expect(o.focus?.match.lifecycle.next?.label).toBe("Generate teams");
    expect(o.focus?.match.href).toBe("/admin/o/org-a/g/group-a/matches/m-next");
  });

  it("past Matches: saved-not-published result, canceled and fully complete (summary SENT) are told apart", async () => {
    const o = await loadGroupOverview(await contextFor("owner@example.test"));
    const byId = Object.fromEntries(o.past.map((m) => [m.id, m]));
    expect(byId["m-past-result"].lifecycle.next?.label).toBe("Publish result");
    expect(byId["m-past-result"].publishedResult).toBeNull(); // unpublished scores are not shown
    expect(byId["m-canceled"].lifecycle.phase).toBe("canceled");
    expect(byId["m-canceled"].lifecycle.next).toBeNull();
    expect(byId["m-done"].lifecycle.phase).toBe("complete");
    expect(byId["m-done"].publishedResult).toEqual({ fixtures: [{ teamA: 1, teamB: 2, scoreA: 5, scoreB: 4, winner: 1 }], legacyStandings: null }); // M8.1 — historical two-team row = one fixture
  });

  it("Needs attention lists only real next steps (next Match + recent past Matches with published teams)", async () => {
    const o = await loadGroupOverview(await contextFor("owner@example.test"));
    expect(o.attention.map((a) => [a.matchId, a.label])).toEqual([
      ["m-next", "Generate teams"],
      ["m-past-result", "Publish result"],
    ]);
    expect(o.attention[1].href).toBe("/admin/o/org-a/g/group-a/matches/m-past-result#result");
  });

  it("MEMBER: same Matches, but no manager-only steps (Match Summary / MVP decision) and no summary state", async () => {
    const o = await loadGroupOverview(await contextFor("member@example.test"));
    expect(o.canManage).toBe(false);
    for (const m of [...o.upcoming, ...o.past]) {
      expect(m.lifecycle.stages.find((s) => s.key === "summary")?.detail).toBe("Owner/admin posts");
      expect(m.lifecycle.next?.label ?? "").not.toMatch(/Match Summary|Player of the Match/);
    }
  });

  it("a Group with no Matches: no focus card, no attention items", async () => {
    await prisma.match.deleteMany({ where: { groupId: "ga" } });
    const o = await loadGroupOverview(await contextFor("owner@example.test"));
    expect(o).toMatchObject({ upcoming: [], past: [], focus: null, attention: [], activePlayers: 4 });
  });

  it("only the URL-resolved Group's data — never another tenant's Matches", async () => {
    const o = await loadGroupOverview(await contextFor("owner@example.test"));
    expect(JSON.stringify(o)).not.toContain("m-b");
    const ob = await loadGroupOverview(await contextFor("other@example.test", B));
    expect(ob.upcoming.map((m) => m.id)).toEqual(["m-b"]);
  });

  it("carries no ratings, stamina or Telegram identity", async () => {
    const o = JSON.stringify(await loadGroupOverview(await contextFor("owner@example.test")));
    expect(o).not.toMatch(/rating|stamina|EXCELLENT|VERY_GOOD|telegram|chatId|"-100"/i);
  });

  it("is read-only", async () => {
    const count = async () => [await prisma.match.count(), await prisma.attendanceResponse.count(), await prisma.messageDelivery.count(), await prisma.matchResult.count()].join(",");
    const before = await count();
    await loadGroupOverview(await contextFor("owner@example.test"));
    expect(await count()).toBe(before);
  });
});

describe("authorization: hidden buttons are not the security boundary", () => {
  it("foreign tenant → 404 on Matches list and Match workspace data", async () => {
    await as("other@example.test");
    expect((await matchesRoute.GET(new Request("http://itest.local/"), g(A))).status).toBe(404);
    expect((await matchRoute.GET(new Request("http://itest.local/"), gm(A, "m-next"))).status).toBe(404);
    // a Match of another Group through this Group's URL is also 404
    await as("owner@example.test");
    expect((await matchRoute.GET(new Request("http://itest.local/"), gm(A, "m-b"))).status).toBe(404);
  });

  it("MEMBER cannot invoke manager-only actions (Telegram sends, MVP selection, poll, match chat) — generic 404, no capability leak", async () => {
    await as("member@example.test");
    const pg = (body: unknown) => postGameRoute.POST(json(body), gm(A, "m-done"));
    for (const body of [
      { action: "post_message", kind: "summary", intent: "post" },
      { action: "start_mvp", intent: "post" },
      { action: "close_mvp" },
      { action: "save_mvp_selection", playerId: "p1" },
      { action: "reset_mvp_selection" },
    ]) {
      const res = await pg(body);
      expect(res.status, JSON.stringify(body)).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }
    expect((await pollRoute.POST(json({ chatRef: 1, intent: "post" }), gm(A, "m-next"))).status).toBe(404);
    expect((await matchChatRoute.POST(json({ chatRef: null }), gm(A, "m-next"))).status).toBe(404);
    const mvp = await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: "m-done" } });
    expect(mvp.selectedPlayerId).toBe("p1"); // unchanged
    expect(await prisma.messageDelivery.count()).toBe(1); // nothing new was reserved or sent
  });

  it("UI-4A: creating a Match is an organizer mutation — MEMBER 404 (nothing created), OWNER 201", async () => {
    await as("member@example.test");
    const before = await prisma.match.count();
    expect((await matchesRoute.POST(json({ date: ymd(dayOffset(20)) }), g(A))).status).toBe(404);
    expect(await prisma.match.count()).toBe(before);
    await as("owner@example.test");
    expect((await matchesRoute.POST(json({ date: ymd(dayOffset(20)) }), g(A))).status).toBe(201);
  });

  it("the only post-game Telegram message kind is the Match Summary", async () => {
    await as("owner@example.test");
    for (const kind of ["result", "mvp", "recap"]) {
      expect((await postGameRoute.POST(json({ action: "post_message", kind, intent: "post" }), gm(A, "m-done"))).status, kind).toBe(400);
    }
  });
});

describe("public Match page DTO stays free of admin fields", () => {
  it("no rating / stamina / internal inputs", async () => {
    const v = await loadMatchForViewer({ ...A, matchId: "m-done" });
    expect(v).not.toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/rating|stamina|EXCELLENT|VERY_GOOD|impact|metrics/i);
  });
});
