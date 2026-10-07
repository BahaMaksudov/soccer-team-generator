/**
 * M9.2 — Communities, roster isolation and Match automation, REAL DATABASE
 * (guarded local test DB only). Telegram and email are stubs; nothing leaves
 * the machine.
 *
 * Scenario: Group A ("Indoor Soccer") has two Communities, UCCNE (27-player
 * style roster) and FunnyStuff; one Player belongs to both. Group B is another
 * tenant.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as communitiesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/communities/route";
import * as communityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/communities/[communityId]/route";
import * as communityPlayersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/communities/[communityId]/players/route";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";
import { playerRating } from "@/lib/playerRating";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import * as pollCloseRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close/route";
import * as venuesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/route";
import * as venueRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/venues/[venueId]/route";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import { loadMatchForViewer } from "@/lib/matchPage";
import * as schedulesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/route";
import * as scheduleRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/route";
import * as scheduleRunRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/[scheduleId]/run/route";
import * as automationRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/automation/route";
import * as cronRoute from "@/app/api/cron/automation/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { testOutbox } from "@/lib/email/transport";
import { loadMyGames } from "@/lib/myGames";
import { setOwnAttendance } from "@/lib/matches";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = "2026-10-12";

// ------------------------------------------------------------ network guard (Telegram stub)
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let stopPollMode: "ok" | "already" | "reject" | "ambiguous" = "ok";
// M9.3 — a definite Telegram refusal of sendPoll (a real poll failure; "no Telegram group" is now web-only, not an error).
let sendPollMode: "ok" | "reject" = "ok";
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
  if (method === "sendPoll" && sendPollMode === "reject")
    return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) } as unknown as Response;
  if (method === "stopPoll" && (stopPollMode === "reject" || stopPollMode === "already"))
    return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: stopPollMode === "already" ? "Bad Request: poll has already been closed" : "Bad Request: message can't be stopped" }) } as unknown as Response;
  return { ok: true, status: 200, json: async () => ({ ok: true, result: method === "sendPoll" ? { message_id: 7, poll: { id: `tg-poll-${tgCalls.length}` } } : { message_id: 1 } }) } as unknown as Response;
}

const json = (method: string, body?: unknown, url = "http://itest.local/") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const g = (at = A) => ({ params: Promise.resolve(at) });
const gc = (communityId: string, at = A) => ({ params: Promise.resolve({ ...at, communityId }) });
const gm = (matchId: string, at = A) => ({ params: Promise.resolve({ ...at, matchId }) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = async (who: string | null) => {
  if (!who) return void (session = null);
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};

const UCCNE = ["u1", "u2", "u3", "u4", "u5", "u6", "shared"]; // + "shared" also in FunnyStuff
const FUNNY = ["f1", "f2", "shared"];

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","CommunityPlayer","Community","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "A", slug: "org-a" }, { id: "org-b", name: "B", slug: "org-b" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Indoor Soccer", slug: "group-a", sportKey: "soccer", timezone: "America/New_York", visibility: "PUBLIC" },
      { id: "gb", organizationId: "org-b", name: "Other", slug: "group-b", sportKey: "soccer", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-admin", organizationId: "org-a", role: "ADMIN" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other", organizationId: "org-b", role: "OWNER" },
    ],
  });
  const ids = [...new Set([...UCCNE, ...FUNNY, "nobody"])];
  const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
  await prisma.player.createMany({
    data: ids.map((id, i) => ({ id, groupId: "ga", firstName: id.toUpperCase(), lastName: "Test", position: i % 3 === 0 ? "DEFENDER" : "MIDFIELDER", rating: ratings[i % 4], stamina: 1 + (i % 5) })),
  });
  await prisma.player.create({ data: { id: "b1", groupId: "gb", firstName: "B", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 3 } });
  await prisma.community.createMany({
    data: [
      { id: "c-uccne", groupId: "ga", name: "UCCNE - Indoor Soccer" },
      { id: "c-funny", groupId: "ga", name: "FunnyStuff" },
      { id: "c-b", groupId: "gb", name: "B community" },
    ],
  });
  await prisma.communityPlayer.createMany({
    data: [...UCCNE.map((playerId) => ({ groupId: "ga", communityId: "c-uccne", playerId })), ...FUNNY.map((playerId) => ({ groupId: "ga", communityId: "c-funny", playerId }))],
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "https://tbp.itest");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
});
beforeEach(async () => {
  session = null;
  tgCalls = [];
  otherNetwork = 0;
  stopPollMode = "ok";
  sendPollMode = "ok";
  testOutbox.clear();
  testOutbox.failNext = 0;
  await seed();
  await signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

const createMatch = (body: Record<string, unknown>, at = A) => call(matchesRoute.POST(json("POST", { date: DAY, startTime: "21:00", ...body }), g(at)));
const view = async (matchId: string, at = A) => (await call(matchRoute.GET(json("GET"), gm(matchId, at)))).body as {
  community: { id: string; name: string } | null;
  roster: Array<{ id: string; inCommunity: boolean; rating?: string }>;
  counts: Record<string, number>;
  rosterSize: number;
  defaultSelection: string[];
};
const members = async (communityId: string) =>
  (await prisma.communityPlayer.findMany({ where: { communityId }, select: { playerId: true }, orderBy: { playerId: "asc" } })).map((r) => r.playerId);

describe("M9.2-1 — migration backfill uses only authoritative relationships", () => {
  it("chat → Community, curated chat scope → memberships, selected chat → Match community; nothing else is inferred", async () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261011120000_m92_communities/migration.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("-- Backfill 1"), sql.indexOf("-- AddForeignKey"));
    const statements = backfill.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
    expect(statements).toHaveLength(4);
    // Pre-M9.2 state: two chats in Group A (one disconnected), a curated scope, Matches with and without a chat.
    await prisma.communityPlayer.deleteMany({});
    await prisma.community.deleteMany({});
    const chatU = await prisma.telegramChat.create({ data: { chatId: -100n, title: "UCCNE Indoor Soccer", groupId: "ga" } });
    const chatF = await prisma.telegramChat.create({ data: { chatId: -200n, title: "  ", groupId: "ga", disconnectedAt: new Date() } });
    await prisma.telegramChatPlayer.createMany({
      data: [
        { groupId: "ga", telegramChatId: chatU.id, playerId: "u1" },
        { groupId: "ga", telegramChatId: chatU.id, playerId: "shared", source: "SUGGESTED_VOTE" },
        { groupId: "ga", telegramChatId: chatF.id, playerId: "shared" },
      ],
    });
    await prisma.match.createMany({ data: [{ id: "m-chat", groupId: "ga", date: new Date(DAY), telegramChatId: chatU.id }, { id: "m-none", groupId: "ga", date: new Date(DAY) }] });
    // A linked voter who answered in chat U but was never added to its scope must NOT become a member.
    await prisma.telegramUserLink.create({ data: { groupId: "ga", userId: 555n, playerId: "u2" } });
    await prisma.telegramPoll.create({ data: { pollId: "p-old", chatId: -100n, question: "q", optionsJson: "[]", groupId: "ga" } });
    await prisma.telegramPollAnswer.create({ data: { pollId: "p-old", userId: 555n, optionIdsJson: "[0]", groupId: "ga" } });

    for (const s of statements) await prisma.$executeRawUnsafe(s);

    const communities = await prisma.community.findMany({ orderBy: { id: "asc" }, select: { id: true, groupId: true, name: true, isActive: true } });
    expect(communities).toEqual([
      { id: `com_tc_${chatU.id}`, groupId: "ga", name: "UCCNE Indoor Soccer", isActive: true },
      { id: `com_tc_${chatF.id}`, groupId: "ga", name: `Telegram group ${chatF.id}`, isActive: false },
    ]);
    expect((await prisma.telegramChat.findMany({ orderBy: { id: "asc" }, select: { communityId: true } })).map((c) => c.communityId)).toEqual([`com_tc_${chatU.id}`, `com_tc_${chatF.id}`]);
    expect(await members(`com_tc_${chatU.id}`)).toEqual(["shared", "u1"]); // u2 (voted, never curated) is NOT a member
    expect(await members(`com_tc_${chatF.id}`)).toEqual(["shared"]);
    expect(await prisma.player.count({ where: { groupId: "ga" } })).toBe(10); // no Player created or duplicated
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m-chat" } })).communityId).toBe(`com_tc_${chatU.id}`);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m-none" } })).communityId).toBeNull(); // not guessed
  });
});

describe("M9.2-1 — Community membership", () => {
  it("one Player row, many memberships; removing one membership keeps the Player and the other membership", async () => {
    expect(await prisma.player.count({ where: { id: "shared" } })).toBe(1);
    expect((await call(communityPlayersRoute.DELETE(json("DELETE", { playerId: "shared" }), gc("c-uccne")))).status).toBe(200);
    expect(await prisma.player.count({ where: { id: "shared" } })).toBe(1);
    expect(await members("c-funny")).toContain("shared");
    expect(await members("c-uccne")).not.toContain("shared");
    // Re-adding is idempotent.
    for (let i = 0; i < 2; i++) expect((await call(communityPlayersRoute.POST(json("POST", { playerId: "shared" }), gc("c-uccne")))).status).toBe(200);
    expect((await members("c-uccne")).filter((p) => p === "shared")).toHaveLength(1);
  });

  it("create / rename / deactivate (OWNER, ADMIN); MEMBER may read names but not change anything", async () => {
    const created = await call(communitiesRoute.POST(json("POST", { name: "Sunday League" }), g()));
    expect(created.status).toBe(201);
    const id = (created.body.community as { id: string }).id;
    await signIn("admin");
    expect((await call(communityRoute.PATCH(json("PATCH", { name: "Sunday League (Fall)", isActive: false }), gc(id)))).status).toBe(200);
    expect(await prisma.community.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Sunday League (Fall)", isActive: false });
    await signIn("member");
    const list = await call(communitiesRoute.GET(json("GET"), g()));
    expect(list.status).toBe(200);
    expect((list.body.communities as Array<{ name: string; telegram: unknown[] }>).map((c) => c.name)).toEqual(expect.arrayContaining(["UCCNE - Indoor Soccer", "FunnyStuff"]));
    expect(JSON.stringify(list.body)).not.toMatch(/rating|stamina|EXCELLENT/);
    expect((await call(communitiesRoute.POST(json("POST", { name: "x" }), g()))).status).toBe(404);
    expect((await call(communityRoute.PATCH(json("PATCH", { isActive: true }), gc(id)))).status).toBe(404);
    expect((await call(communityPlayersRoute.POST(json("POST", { playerId: "u1" }), gc("c-funny")))).status).toBe(404);
    expect((await call(communityPlayersRoute.DELETE(json("DELETE", { playerId: "u1" }), gc("c-uccne")))).status).toBe(404);
    expect(await members("c-uccne")).toContain("u1");
  });

  it("cross-tenant: another Group's Community / Player / URL are all 404, and the database refuses mixed rows", async () => {
    expect((await call(communityPlayersRoute.POST(json("POST", { playerId: "b1" }), gc("c-uccne")))).status).toBe(404); // foreign Player
    expect((await call(communityPlayersRoute.POST(json("POST", { playerId: "u1" }), gc("c-b")))).status).toBe(404); // foreign Community via A's URL
    expect((await call(communityRoute.PATCH(json("PATCH", { name: "pwned" }), gc("c-b")))).status).toBe(404);
    await signIn("other");
    expect((await call(communitiesRoute.GET(json("GET"), g()))).status).toBe(404);
    expect((await call(communityPlayersRoute.POST(json("POST", { playerId: "b1" }), gc("c-uccne", B)))).status).toBe(404);
    for (const data of [
      { groupId: "ga", communityId: "c-uccne", playerId: "b1" },
      { groupId: "gb", communityId: "c-uccne", playerId: "b1" },
      { groupId: "ga", communityId: "c-b", playerId: "u1" },
    ]) await expect(prisma.communityPlayer.create({ data })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.match.create({ data: { groupId: "ga", date: new Date(DAY), communityId: "c-b" } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("M9.2-1 — Match community and roster isolation", () => {
  it("a new Match must name its Community when there are several; foreign / unknown / inactive ids are rejected", async () => {
    expect((await createMatch({})).status).toBe(400);
    expect((await createMatch({ communityId: "c-b" })).status).toBe(404);
    expect((await createMatch({ communityId: "nope" })).status).toBe(404);
    await prisma.community.update({ where: { id: "c-funny" }, data: { isActive: false } });
    expect((await createMatch({ communityId: "c-funny" })).status).toBe(404);
    // With exactly one active Community it is the default.
    const one = await createMatch({});
    expect(one.status).toBe(201);
    expect((one.body.match as { communityId: string }).communityId).toBe("c-uccne");
  });

  it("UCCNE Match: only UCCNE's roster (shared Player once, FunnyStuff-only absent); counts add up to the roster", async () => {
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    const v = await view(id);
    expect(v.community).toMatchObject({ id: "c-uccne", name: "UCCNE - Indoor Soccer" });
    expect(v.roster.map((p) => p.id).sort()).toEqual([...UCCNE].sort());
    expect(v.roster.filter((p) => p.id === "shared")).toHaveLength(1);
    expect(v.roster.some((p) => p.id === "f1" || p.id === "nobody")).toBe(false);
    expect(v.rosterSize).toBe(UCCNE.length);
    expect(v.counts).toEqual({ PLAYING: 0, MAYBE: 0, NOT_PLAYING: 0, NO_RESPONSE: UCCNE.length });
  });

  it("generation and publish reject a Player outside the Match's Community (server-side), accept the Community's own", async () => {
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    const bad = await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2", "u3", "f1"], matchId: id }), g()));
    expect(bad).toMatchObject({ status: 400, body: { error: "One or more selected players are not in this match's community." } });
    const ok = await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2", "u3", "shared"], matchId: id }), g()));
    expect(ok.status).toBe(200);
    const forged = [{ teamNumber: 1, players: [{ id: "u1" }, { id: "f1" }] }, { teamNumber: 2, players: [{ id: "u2" }, { id: "u3" }] }];
    expect((await call(publishRoute.POST(json("POST", { date: DAY, teams: forged, matchId: id }), g()))).status).toBe(400);
    expect(await prisma.teamGeneration.count({ where: { matchId: id } })).toBe(0);
    expect((await call(publishRoute.POST(json("POST", { date: DAY, teams: ok.body.teams, matchId: id }), g()))).status).toBe(200);
    // Another Group's Match id through A's URL is 404 (never generated against).
    await prisma.match.create({ data: { id: "mb", groupId: "gb", date: new Date(DAY), communityId: "c-b" } });
    expect((await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2"], matchId: "mb" }), g()))).status).toBe(404);
  });

  it("a responder outside the Community is listed (flagged) but never counted or selected by default", async () => {
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    await call(overrideRoute.POST(json("POST", { playerId: "u1", status: "PLAYING" }), gm(id)));
    await call(overrideRoute.POST(json("POST", { playerId: "f1", status: "PLAYING" }), gm(id)));
    const v = await view(id);
    expect(v.roster.find((p) => p.id === "f1")).toMatchObject({ inCommunity: false });
    expect(v.roster.find((p) => p.id === "u1")).toMatchObject({ inCommunity: true });
    expect(v.counts).toEqual({ PLAYING: 1, MAYBE: 0, NOT_PLAYING: 0, NO_RESPONSE: UCCNE.length - 1 });
    expect(v.defaultSelection).toEqual(["u1"]);
  });

  it("a legacy Match without a Community keeps the whole-Group roster until an organizer assigns one", async () => {
    await prisma.match.create({ data: { id: "legacy", groupId: "ga", date: new Date(DAY) } });
    expect((await view("legacy")).roster).toHaveLength(10);
    expect((await call(matchRoute.PATCH(json("PATCH", { communityId: "c-funny" }), gm("legacy")))).status).toBe(200);
    const v = await view("legacy");
    expect(v.community?.id).toBe("c-funny");
    expect(v.roster.map((p) => p.id).sort()).toEqual([...FUNNY].sort());
    expect((await call(matchRoute.PATCH(json("PATCH", { communityId: "c-b" }), gm("legacy")))).status).toBe(404);
  });

  it("MEMBER sees the community roster without skill/stamina; nothing was sent", async () => {
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    await signIn("member");
    const v = await view(id);
    expect(v.roster.map((p) => p.id).sort()).toEqual([...UCCNE].sort());
    expect(JSON.stringify(v.roster)).not.toMatch(/"rating"|"stamina"/);
    expect(tgCalls).toEqual([]);
    expect(otherNetwork).toBe(0);
  });
});

describe("M9.2-2 — Players API: Community memberships and the 0–10 Rating", () => {
  type Row = { id: string; rating?: string; stamina?: number; playerRating?: number; communityIds: string[] };
  const list = async (at = A) => (await call(playersRoute.GET(json("GET"), g(at)))) as { status: number; body: unknown };
  it("OWNER / ADMIN: every Player once, with its memberships and a rating derived from skill + stamina (Group config)", async () => {
    for (const who of ["owner", "admin"]) {
      await signIn(who);
      const rows = (await list()).body as Row[];
      expect(rows.map((r) => r.id).sort()).toEqual([...new Set([...UCCNE, ...FUNNY, "nobody"])].sort());
      const shared = rows.find((r) => r.id === "shared")!;
      expect(shared.communityIds.sort()).toEqual(["c-funny", "c-uccne"]);
      expect(rows.find((r) => r.id === "nobody")!.communityIds).toEqual([]);
      for (const r of rows) expect(r.playerRating).toBe(playerRating({ rating: r.rating!, stamina: r.stamina! }, 1));
    }
    // The Group's own stamina coefficient is used (organizer configuration).
    await signIn("owner");
    expect((await call(weightsRoute.PUT(json("PUT", { weights: { staminaCoef: 3, positionWeights: {} } }), g()))).status).toBe(200);
    const rows = (await list()).body as Row[];
    for (const r of rows) expect(r.playerRating).toBe(playerRating({ rating: r.rating!, stamina: r.stamina! }, 3));
  });
  it("MEMBER: memberships but never skill / stamina / rating; other tenants 404", async () => {
    await signIn("member");
    const res = await list();
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/"rating"|"stamina"|"playerRating"/);
    expect(((res.body as Row[]).find((r) => r.id === "shared")!.communityIds).sort()).toEqual(["c-funny", "c-uccne"]);
    await signIn("other");
    expect((await list()).status).toBe(404);
  });
});

describe("M9.2-3 — Player of the Match eligibility = actual participants of the Match's Community", () => {
  const pg = (matchId: string, body: unknown) => call(postGameRoute.POST(json("POST", body), gm(matchId)));
  it("published participants only; Not Playing and other-Community players are never candidates (web selection and vote alike)", async () => {
    // UCCNE's Telegram group (the Match picks it up as its channel).
    await prisma.telegramChat.create({ data: { chatId: -9100n, title: "UCCNE chat", groupId: "ga", communityId: "c-uccne" } });
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).telegramChatId).not.toBeNull();
    // A published snapshot that (as legacy data could) contains a FunnyStuff-only player f1.
    const P = (pid: string) => ({ id: pid, firstName: pid.toUpperCase(), lastName: "Test", position: "MIDFIELDER", rating: "GOOD", stamina: 3 });
    await prisma.teamGeneration.create({ data: { groupId: "ga", matchId: id, date: new Date(DAY), teamsJson: JSON.stringify([{ teamNumber: 1, players: [P("u1"), P("u2"), P("f1")] }, { teamNumber: 2, players: [P("u3"), P("u4"), P("shared")] }]) } });
    for (const [playerId, status] of [["u1", "PLAYING"], ["u2", "NOT_PLAYING"], ["u3", "MAYBE"], ["shared", "PLAYING"]] as const)
      await call(overrideRoute.POST(json("POST", { playerId, status }), gm(id)));
    await pg(id, { action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 3, scoreB: 2 }] });
    await pg(id, { action: "publish_result" });

    const v = (await call(matchRoute.GET(json("GET"), gm(id)))).body as { postGame: { participants: Array<{ playerId: string }> } };
    // u4 never responded but played (on the published teams) → eligible; MAYBE on a team → eligible.
    expect(v.postGame.participants.map((p) => p.playerId).sort()).toEqual(["shared", "u1", "u3", "u4"]);
    for (const bad of ["u2", "f1", "u5", "b1", "nobody"]) expect((await pg(id, { action: "save_mvp_selection", playerId: bad })).status, bad).toBe(404);
    expect((await pg(id, { action: "save_mvp_selection", playerId: "u1" })).status).toBe(200);
    // A Telegram vote's candidate list is checked against the same set (before anything is sent).
    expect((await pg(id, { action: "reset_mvp_selection" })).status).toBe(200);
    expect((await pg(id, { action: "start_mvp", candidateIds: ["u1", "f1"] })).status).toBe(404);
    expect(tgCalls).toEqual([]);
  });
  it("POTM still requires a published result", async () => {
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    const ok = await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2", "u3", "u4"], matchId: id }), g()));
    await call(publishRoute.POST(json("POST", { date: DAY, teams: ok.body.teams, matchId: id }), g()));
    expect((await pg(id, { action: "save_mvp_selection", playerId: "u1" })).body.error).toBe("Publish the final result before choosing Player of the Match.");
  });
});

describe("M9.2-4 — publishing teams closes the Match's Telegram attendance poll (server-side)", () => {
  async function matchWithOpenPoll() {
    await prisma.telegramChat.create({ data: { chatId: -9200n, title: "UCCNE chat", groupId: "ga", communityId: "c-uccne" } });
    const id = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    await prisma.telegramPoll.create({ data: { pollId: "att-1", chatId: -9200n, messageId: 55n, question: "Playing?", optionsJson: "[]", pollDate: new Date(DAY), isClosed: false, groupId: "ga", matchId: id, kind: "ATTENDANCE" } });
    // A linked voter answered "Playing" but the webhook update was missed: the final sync records it before closing.
    await prisma.telegramUserLink.create({ data: { groupId: "ga", userId: 777n, playerId: "u5" } });
    await prisma.telegramPollAnswer.create({ data: { pollId: "att-1", userId: 777n, optionIdsJson: "[0]", groupId: "ga" } });
    return id;
  }
  const publish = async (id: string, at = A) => {
    const gen = await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2", "u3", "u4"], matchId: id }), g(at)));
    return call(publishRoute.POST(json("POST", { date: DAY, teams: gen.body.teams, matchId: id }), g(at)));
  };
  const sends = () => tgCalls.filter((c) => c.method === "sendMessage" || c.method === "sendPoll").length;
  const stopPolls = () => tgCalls.filter((c) => c.method === "stopPoll").length;
  const pollRow = () => prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "att-1" } });

  it("open poll: final sync, stopPoll once, poll closed; repeating Publish is idempotent; no team post is ever sent", async () => {
    const id = await matchWithOpenPoll();
    const first = await publish(id);
    expect(first).toMatchObject({ status: 200, body: { ok: true, poll: { status: "closed" } } });
    expect(stopPolls()).toBe(1);
    expect(tgCalls.find((c) => c.method === "stopPoll")!.body).toEqual({ chat_id: "-9200", message_id: 55 });
    expect((await pollRow()).isClosed).toBe(true);
    expect(await prisma.attendanceResponse.findFirst({ where: { matchId: id, playerId: "u5" }, select: { participantStatus: true } })).toEqual({ participantStatus: "PLAYING" });
    const again = await publish(id);
    expect(again.body).toMatchObject({ ok: true, poll: { status: "already_closed" } });
    expect(stopPolls()).toBe(1);
    expect(sends()).toBe(0);
    expect(await prisma.messageDelivery.count()).toBe(0);
  });

  it("already closed on Telegram → recorded as closed", async () => {
    const id = await matchWithOpenPoll();
    stopPollMode = "already";
    expect((await publish(id)).body).toMatchObject({ ok: true, poll: { status: "closed" } });
    expect((await pollRow()).isClosed).toBe(true);
  });

  it("definite Telegram refusal → teams stay published, poll reported FAILED and left open; retry closes it", async () => {
    const id = await matchWithOpenPoll();
    stopPollMode = "reject";
    const r = await publish(id);
    expect(r).toMatchObject({ status: 200, body: { ok: true, poll: { status: "failed" } } });
    expect(String((r.body.poll as { message: string }).message)).toMatch(/refused/);
    expect(await prisma.teamGeneration.count({ where: { matchId: id } })).toBe(1);
    expect((await pollRow()).isClosed).toBe(false);
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id)))).status).toBe(502);
    stopPollMode = "ok";
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id)))).body).toMatchObject({ ok: true, status: "closed" });
    expect((await pollRow()).isClosed).toBe(true);
  });

  it("uncertain Telegram response → never shown as success; poll left open; a retry is safe", async () => {
    const id = await matchWithOpenPoll();
    stopPollMode = "ambiguous";
    const r = await publish(id);
    expect(r.body).toMatchObject({ ok: true, poll: { status: "uncertain" } });
    expect((await pollRow()).isClosed).toBe(false);
    expect(await prisma.teamGeneration.count({ where: { matchId: id } })).toBe(1);
    stopPollMode = "already"; // Telegram had in fact closed it
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id)))).body).toMatchObject({ ok: true, status: "closed" });
    expect(sends()).toBe(0);
  });

  it("a Match without a poll publishes normally; MEMBER and other tenants can neither close nor publish (no Telegram call)", async () => {
    const plain = ((await createMatch({ communityId: "c-uccne" })).body.match as { id: string }).id;
    expect((await publish(plain)).body).toMatchObject({ ok: true, poll: { status: "no_poll", message: null } });
    const id = await matchWithOpenPoll();
    await signIn("member");
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id)))).status).toBe(404);
    await signIn("other");
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id)))).status).toBe(404);
    expect((await call(pollCloseRoute.POST(json("POST", {}), gm(id, B)))).status).toBe(404);
    expect((await call(publishRoute.POST(json("POST", { date: DAY, teams: [{ teamNumber: 1, players: [{ id: "b1" }] }], matchId: id }), g(B)))).status).toBe(404);
    expect(stopPolls()).toBe(0);
    expect((await pollRow()).isClosed).toBe(false);
  });
});

describe("M9.2-5 — reusable Venues, match location and the Telegram maps link", () => {
  const gv = (venueId: string, at = A) => ({ params: Promise.resolve({ ...at, venueId }) });
  const addVenue = async (body: unknown, at = A) => call(venuesRoute.POST(json("POST", body), g(at)));
  it("OWNER / ADMIN manage the Organization's venues; MEMBER and other tenants cannot see or change them", async () => {
    const v = await addVenue({ name: "ForeKicks", address: "10 Pine Street, Norfolk, MA" });
    expect(v.status).toBe(201);
    const id = (v.body.venue as { id: string }).id;
    await signIn("admin");
    expect((await call(venueRoute.PATCH(json("PATCH", { address: "11 Pine Street, Norfolk, MA" }), gv(id)))).status).toBe(200);
    const list = await call(venuesRoute.GET(json("GET"), g()));
    expect(list.body.venues).toEqual([{ id, name: "ForeKicks", address: "11 Pine Street, Norfolk, MA", isActive: true, mapsUrl: "https://www.google.com/maps/search/?api=1&query=11%20Pine%20Street%2C%20Norfolk%2C%20MA" }]);
    await signIn("member");
    expect((await call(venuesRoute.GET(json("GET"), g()))).status).toBe(404);
    expect((await addVenue({ name: "x" })).status).toBe(404);
    await signIn("other");
    expect((await call(venueRoute.PATCH(json("PATCH", { name: "pwned" }), gv(id, B)))).status).toBe(404);
    expect((await prisma.venue.findUniqueOrThrow({ where: { id } })).name).toBe("ForeKicks");
  });

  it("a Match uses a Venue of its own Organization only; name becomes the location; address → maps link (organizer + public views)", async () => {
    const id = ((await addVenue({ name: "ForeKicks", address: "10 Pine Street, Norfolk, MA" })).body.venue as { id: string }).id;
    const bVenue = await prisma.venue.create({ data: { organizationId: "org-b", name: "Secret B", address: "B street" } });
    expect((await createMatch({ communityId: "c-uccne", venueId: bVenue.id })).status).toBe(404);
    const created = await createMatch({ communityId: "c-uccne", venueId: id });
    expect(created.status).toBe(201);
    const m = created.body.match as { id: string; locationName: string; venue: { name: string; address: string; mapsUrl: string } };
    expect(m.locationName).toBe("ForeKicks");
    expect(m.venue).toMatchObject({ name: "ForeKicks", address: "10 Pine Street, Norfolk, MA", mapsUrl: expect.stringContaining("query=10%20Pine%20Street") });
    expect((await call(matchRoute.PATCH(json("PATCH", { venueId: bVenue.id }), gm(m.id)))).status).toBe(404);
    session = null;
    const pub = await loadMatchForViewer({ ...A, matchId: m.id });
    expect(pub?.venue).toEqual({ name: "ForeKicks", address: "10 Pine Street, Norfolk, MA", mapsUrl: expect.stringContaining("google.com/maps/search") });
    await signIn("owner");
    expect((await call(matchRoute.PATCH(json("PATCH", { venueId: null }), gm(m.id)))).status).toBe(200);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m.id } })).venueId).toBeNull();
  });

  it("the Telegram team post shows 📍 venue + a clickable maps link (explicit post only; hash unaffected)", async () => {
    const venueId = ((await addVenue({ name: "ForeKicks", address: "10 Pine Street, Norfolk, MA" })).body.venue as { id: string }).id;
    await prisma.telegramChat.create({ data: { chatId: -9300n, title: "UCCNE chat", groupId: "ga", communityId: "c-uccne" } });
    const id = ((await createMatch({ communityId: "c-uccne", venueId })).body.match as { id: string }).id;
    await prisma.telegramPoll.create({ data: { pollId: "att-v", chatId: -9300n, messageId: 9n, question: "Playing?", optionsJson: "[]", pollDate: new Date(DAY), isClosed: true, groupId: "ga", matchId: id, kind: "ATTENDANCE" } });
    const gen = await call(generateRoute.POST(json("POST", { teamCount: 2, date: DAY, selectedIds: ["u1", "u2", "u3", "u4"], matchId: id }), g()));
    const pub = await call(publishRoute.POST(json("POST", { date: DAY, teams: gen.body.teams, matchId: id }), g()));
    expect(tgCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0); // publishing never posts
    const posted = await call(closePostRoute.POST(json("POST", { pollId: "att-v", teamGenerationId: pub.body.id, intent: "post" }), g()));
    expect(posted.body).toMatchObject({ ok: true, status: "posted" });
    const text = String(tgCalls.find((c) => c.method === "sendMessage")!.body.text);
    expect(text).toContain("📍 ForeKicks");
    expect(text).toContain('Location: <a href="https://www.google.com/maps/search/?api=1&amp;query=10%20Pine%20Street%2C%20Norfolk%2C%20MA">10 Pine Street, Norfolk, MA</a>');
    // Re-posting the same teams is "already posted" even though the stored hash never included the venue.
    expect((await call(closePostRoute.POST(json("POST", { pollId: "att-v", teamGenerationId: pub.body.id, intent: "post" }), g()))).body).toMatchObject({ status: "already_posted" });
    expect(tgCalls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});

describe("M9.2-6/7 — weekly schedules and the Match Automation Agent", () => {
  // Monday 9 PM New York; poll Sunday 8 PM; cutoff Monday 8 PM.
  const SCHED = { communityId: "c-uccne", timezone: "America/New_York", weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
  const T = {
    beforePoll: new Date("2026-10-11T23:00:00Z"), // Sun 19:00 EDT
    afterPoll: new Date("2026-10-12T00:05:00Z"), // Sun 20:05 EDT
    afterCutoff: new Date("2026-10-13T00:05:00Z"), // Mon 20:05 EDT
  };
  const gs = (scheduleId: string, at = A) => ({ params: Promise.resolve({ ...at, scheduleId }) });
  const sends = (m: string) => tgCalls.filter((c) => c.method === m).length;
  async function setup(opts: { chat?: boolean } = {}) {
    if (opts.chat !== false) await prisma.telegramChat.create({ data: { chatId: -9400n, title: "UCCNE chat", groupId: "ga", communityId: "c-uccne" } });
    const venue = await prisma.venue.create({ data: { organizationId: "org-a", name: "ForeKicks", address: "10 Pine Street, Norfolk, MA" } });
    const created = await call(schedulesRoute.POST(json("POST", { ...SCHED, venueId: venue.id }), g()));
    expect(created.status).toBe(201);
    return (created.body.schedule as { id: string }).id;
  }
  const scheduledMatches = () => prisma.match.findMany({ where: { scheduleId: { not: null } }, include: { automation: true } });

  it("schedule CRUD: validation, next occurrence, organizer-only, tenant-scoped", async () => {
    const id = await setup();
    const list = await call(schedulesRoute.GET(json("GET"), g()));
    const s = (list.body.schedules as Array<Record<string, unknown>>)[0];
    expect(s).toMatchObject({ communityName: "UCCNE - Indoor Soccer", venueName: "ForeKicks", weekday: 1, startTime: "21:00", isActive: true });
    for (const [body, status] of [
      [{ ...SCHED, timezone: "Mars/Base" }, 400],
      [{ ...SCHED, cutoffDaysBefore: 1, cutoffTime: "19:00" }, 400], // cutoff before poll
      [{ ...SCHED, cutoffTime: "22:00" }, 400], // cutoff after game
      [{ ...SCHED, communityId: "c-b" }, 404],
      [{ ...SCHED, weekday: 7 }, 400],
    ] as const) expect((await call(schedulesRoute.POST(json("POST", body), g()))).status, JSON.stringify(body)).toBe(status);
    expect((await call(scheduleRoute.PATCH(json("PATCH", { startTime: "21:30" }), gs(id)))).body).toMatchObject({ ok: true, schedule: { startTime: "21:30" } });
    await signIn("member");
    expect((await call(schedulesRoute.GET(json("GET"), g()))).status).toBe(404);
    expect((await call(scheduleRoute.PATCH(json("PATCH", { isActive: false }), gs(id)))).status).toBe(404);
    await signIn("other");
    expect((await call(scheduleRoute.PATCH(json("PATCH", { isActive: false }), gs(id, B)))).status).toBe(404);
    expect((await prisma.matchSchedule.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
  });

  it("full cycle: nothing before poll time → Match + poll exactly once (repeat & concurrent runs) → cutoff closes poll + attendance → organizers emailed once → teams NEVER published", async () => {
    await setup();
    expect(await runMatchAutomation(T.beforePoll)).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(await scheduledMatches()).toHaveLength(0);

    const runs = await Promise.all([runMatchAutomation(T.afterPoll), runMatchAutomation(T.afterPoll), runMatchAutomation(T.afterPoll)]);
    await runMatchAutomation(T.afterPoll);
    expect(runs.reduce((n, r) => n + r.created, 0)).toBe(1);
    const [m] = await scheduledMatches();
    expect(await scheduledMatches()).toHaveLength(1);
    expect(m).toMatchObject({ communityId: "c-uccne", startTime: "21:00", locationName: "ForeKicks", date: new Date("2026-10-12T00:00:00Z") });
    expect(m.automation).toMatchObject({ pollDueAt: new Date("2026-10-12T00:00:00Z"), cutoffDueAt: new Date("2026-10-13T00:00:00Z") });
    expect(m.automation!.pollPostedAt).not.toBeNull();
    expect(sends("sendPoll")).toBe(1);
    expect(await prisma.messageDelivery.count({ where: { eventType: "ATTENDANCE_POLL_POSTED", status: "SENT" } })).toBe(1);

    // Answers arrive (linked voters).
    const poll = await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: m.id, kind: "ATTENDANCE" } });
    for (const [uid, pid, option] of [[1n, "u1", 0], [2n, "u2", 0], [3n, "u3", 1], [4n, "u4", 2]] as const) {
      await prisma.telegramUserLink.create({ data: { groupId: "ga", userId: uid, playerId: pid } });
      await prisma.telegramPollAnswer.create({ data: { pollId: poll.pollId, userId: uid, optionIdsJson: JSON.stringify([option]), groupId: "ga" } });
      await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: m.id, groupId: "ga", telegramUserId: uid, optionIds: [option], at: T.afterPoll }));
    }

    await Promise.all([runMatchAutomation(T.afterCutoff), runMatchAutomation(T.afterCutoff)]);
    await runMatchAutomation(T.afterCutoff);
    const after = await prisma.match.findUniqueOrThrow({ where: { id: m.id }, include: { automation: true } });
    expect(after.attendanceClosedAt).not.toBeNull();
    expect(after.automation!.cutoffCompletedAt).not.toBeNull();
    expect(after.automation!.notifiedAt).not.toBeNull();
    expect(sends("stopPoll")).toBe(1);
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: poll.pollId } })).isClosed).toBe(true);

    // One email per organizer (OWNER + ADMIN), counts over UCCNE's 7-player roster: 2 playing, 1 maybe? (option 1), 1 not playing, 3 not responded.
    expect(testOutbox.sent.map((e) => e.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    const text = testOutbox.sent[0].text;
    expect(text).toMatch(/Playing: 2 · Maybe: \d · Not playing: \d · Not responded: 3 \(roster 7\)/);
    expect(text).toContain("https://tbp.itest/admin/o/org-a/g/group-a/matches/" + m.id);
    expect(text).toContain("Teams are never published automatically");
    expect(testOutbox.sent.some((e) => e.to === "member@example.test")).toBe(false);

    // Never: teams, team posts or any other message.
    expect(await prisma.teamGeneration.count()).toBe(0);
    expect(sends("sendMessage")).toBe(0);
    expect(otherNetwork).toBe(0);
  });

  it("not retroactive: a schedule created after the cutoff creates nothing for that week", async () => {
    await setup();
    expect(await runMatchAutomation(T.afterCutoff)).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(await scheduledMatches()).toHaveLength(0);
  });

  it("a paused schedule does nothing (and its pending cutoff stops)", async () => {
    const id = await setup();
    await runMatchAutomation(T.afterPoll);
    await call(scheduleRoute.PATCH(json("PATCH", { isActive: false }), gs(id)));
    await runMatchAutomation(T.afterCutoff);
    const [m] = await scheduledMatches();
    expect(m.automation!.cutoffCompletedAt).toBeNull();
    expect(testOutbox.sent).toHaveLength(0);
    expect(sends("stopPoll")).toBe(0);
  });

  it("failures are recorded for the organizer and retried safely: Telegram refuses the poll, then email failure", async () => {
    await setup();
    sendPollMode = "reject";
    const r = await runMatchAutomation(T.afterPoll);
    expect(r.created).toBe(1);
    const [m] = await scheduledMatches();
    expect(m.automation!.lastError).toMatch(/attendance poll could not be posted/);
    expect(m.automation!.pollPostedAt).toBeNull();
    const refused = sends("sendPoll"); // definite refusals (the run's pending-poll pass retries once)
    expect(refused).toBeGreaterThanOrEqual(1);
    // Telegram recovers; the organizer retries from the Match (only what is due runs).
    sendPollMode = "ok";
    // The route runs at the real clock: pin it to the poll window for this check.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T.afterPoll);
    try {
      expect((await call(automationRoute.POST(json("POST", {}), gm(m.id)))).body).toMatchObject({ pollsPosted: 1 });
      expect(sends("sendPoll")).toBe(refused + 1);
      expect((await call(automationRoute.POST(json("POST", {}), gm(m.id)))).body).toMatchObject({ pollsPosted: 0 });
      expect(sends("sendPoll")).toBe(refused + 1);
    } finally {
      vi.useRealTimers();
    }

    testOutbox.failNext = 1;
    await runMatchAutomation(T.afterCutoff);
    let a = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } });
    expect(a.cutoffCompletedAt).not.toBeNull();
    expect(a.notifiedAt).toBeNull();
    expect(a.lastError).toMatch(/email could not be sent/);
    await runMatchAutomation(T.afterCutoff);
    a = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } });
    expect(a.notifiedAt).not.toBeNull();
    await runMatchAutomation(T.afterCutoff);
    expect(sends("stopPoll")).toBe(1);
  });

  it("M9.3 — a Community WITHOUT Telegram is web-only: no poll, no error, no Telegram call; attendance via the Match Link", async () => {
    await setup({ chat: false });
    expect(await runMatchAutomation(T.afterPoll)).toMatchObject({ created: 1, pollsPosted: 0, errors: [] });
    const [m] = await scheduledMatches();
    expect(m.automation!.lastError).toBeNull();
    expect(m.automation!.pollPostedAt).not.toBeNull();
    expect(await runMatchAutomation(T.afterCutoff)).toMatchObject({ cutoffs: 1, notified: 1, errors: [] });
    expect(tgCalls).toHaveLength(0);
  });

  it("editing a schedule affects new Matches only; existing due times are kept", async () => {
    const id = await setup();
    await runMatchAutomation(T.afterPoll);
    await call(scheduleRoute.PATCH(json("PATCH", { cutoffTime: "18:00" }), gs(id)));
    const [m] = await scheduledMatches();
    expect(m.automation!.cutoffDueAt).toEqual(new Date("2026-10-13T00:00:00Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T.beforePoll);
    try {
      const next = (await call(schedulesRoute.GET(json("GET"), g()))).body.schedules as Array<{ next: { cutoffAt: string } }>;
      expect(next[0].next.cutoffAt).toBe("2026-10-12T22:00:00.000Z"); // the same game, now with the new cutoff (Mon 18:00 EDT)
    } finally {
      vi.useRealTimers();
    }
  });

  it("cron endpoint is fail-closed (503 without CRON_SECRET, 401 for wrong/missing token); organizer run endpoint is OWNER/ADMIN + tenant-scoped", async () => {
    const req = (auth?: string, url = "http://itest.local/api/cron/automation") => new Request(url, { method: "POST", headers: auth ? { authorization: auth } : {} });
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    try {
      vi.stubEnv("CRON_SECRET", "");
      expect((await cronRoute.POST(req("Bearer anything"))).status).toBe(503);
      vi.stubEnv("CRON_SECRET", "a-long-enough-test-secret");
      expect((await cronRoute.POST(req())).status).toBe(401);
      expect((await cronRoute.POST(req("Bearer wrong-secret-value"))).status).toBe(401);
      expect((await cronRoute.POST(req("a-long-enough-test-secret"))).status).toBe(401); // not a Bearer header
      expect((await cronRoute.POST(req(undefined, "http://itest.local/api/cron/automation?secret=a-long-enough-test-secret"))).status).toBe(401); // never a query string
      // Correct (fake) secret: the scheduler runs (a real schedule is due → the Match + poll are created).
      await setup();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T.afterPoll);
      const ok = await call(cronRoute.POST(req("Bearer a-long-enough-test-secret")));
      vi.useRealTimers();
      expect(ok).toMatchObject({ status: 200, body: { ok: true, created: 1, pollsPosted: 1, errorCount: 0 } });
      expect(JSON.stringify(ok.body)).not.toContain("a-long-enough-test-secret");
      expect(logs.join("\n")).not.toContain("a-long-enough-test-secret");
    } finally {
      vi.useRealTimers();
      spies.forEach((s) => s.mockRestore());
      vi.stubEnv("CRON_SECRET", "");
    }
    const [m] = await scheduledMatches();
    await signIn("member");
    expect((await call(automationRoute.POST(json("POST", {}), gm(m.id)))).status).toBe(404);
    await signIn("other");
    expect((await call(automationRoute.POST(json("POST", {}), gm(m.id, B)))).status).toBe(404);
  });

  // ---------------------------------------------------------------- per-recipient organizer email
  async function toCutoff() {
    await setup();
    await runMatchAutomation(T.afterPoll);
    const [m] = await scheduledMatches();
    return m;
  }
  const emailRows = async (matchId: string) =>
    prisma.matchAutomationEmail.findMany({ where: { automation: { matchId } }, select: { userId: true, sentAt: true, skippedReason: true, attempts: true }, orderBy: { userId: "asc" } });
  function failFor(addresses: string[]) {
    const fail = new Set(addresses);
    const original = testOutbox.send.bind(testOutbox);
    return vi.spyOn(testOutbox, "send").mockImplementation(async (msg) => {
      if (fail.has(msg.to)) throw new Error("Email delivery failed (http 503).");
      return original(msg);
    });
  }

  it("email is idempotent PER RECIPIENT: OWNER sent + ADMIN failed → retry sends only the ADMIN; MEMBER never; unverified / malformed addresses skipped", async () => {
    await prisma.user.createMany({
      data: [
        { id: "u-admin2", email: "admin2@example.test", name: "admin2", passwordHash: null, emailVerifiedAt: null }, // not verified
        { id: "u-admin3", email: "not-an-email", name: "admin3", passwordHash: null, emailVerifiedAt: VERIFIED }, // malformed
      ],
    });
    await prisma.organizationMembership.createMany({
      data: [
        { userId: "u-admin2", organizationId: "org-a", role: "ADMIN" },
        { userId: "u-admin3", organizationId: "org-a", role: "ADMIN" },
      ],
    });
    const m = await toCutoff();
    const spy = failFor(["admin@example.test"]);
    try {
      await runMatchAutomation(T.afterCutoff);
    } finally {
      spy.mockRestore();
    }
    expect(testOutbox.sent.map((e) => e.to)).toEqual(["owner@example.test"]);
    let a = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } });
    expect(a.cutoffCompletedAt).not.toBeNull();
    expect(a.notifiedAt).toBeNull(); // still retryable
    expect(a.lastError).toMatch(/could not be sent to 1 of 4 organizers/);
    expect(await emailRows(m.id)).toEqual([
      { userId: "u-admin", sentAt: null, skippedReason: null, attempts: 1 },
      { userId: "u-admin2", sentAt: null, skippedReason: "EMAIL_NOT_VERIFIED", attempts: 0 },
      { userId: "u-admin3", sentAt: null, skippedReason: "INVALID_EMAIL", attempts: 0 },
      { userId: "u-owner", sentAt: expect.any(Date), skippedReason: null, attempts: 1 },
    ]);
    // The organizer's view shows the partial state.
    expect(((await call(matchRoute.GET(json("GET"), gm(m.id)))).body.automation as Record<string, unknown>).emails).toEqual({ sent: 1, skipped: 2, pending: 1 });

    // Retry (a new run = a new process as far as state goes): only the ADMIN is sent; the OWNER is not emailed again.
    await runMatchAutomation(T.afterCutoff);
    expect(testOutbox.sent.map((e) => e.to)).toEqual(["owner@example.test", "admin@example.test"]);
    a = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } });
    expect(a.notifiedAt).not.toBeNull();
    expect(a.lastError).toBeNull();
    // Complete → further runs send nothing.
    await runMatchAutomation(T.afterCutoff);
    await runMatchAutomation(new Date(T.afterCutoff.getTime() + 3600_000));
    expect(testOutbox.sent).toHaveLength(2);
    expect(testOutbox.sent.some((e) => e.to === "member@example.test" || e.to === "admin2@example.test" || e.to === "not-an-email")).toBe(false);
    expect(((await call(matchRoute.GET(json("GET"), gm(m.id)))).body.automation as Record<string, unknown>).emails).toEqual({ sent: 2, skipped: 2, pending: 0 });
  });

  it("concurrent scheduler runs never duplicate a recipient's email (also after a partial failure)", async () => {
    const m = await toCutoff();
    const spy = failFor(["admin@example.test"]);
    try {
      await Promise.all([runMatchAutomation(T.afterCutoff), runMatchAutomation(T.afterCutoff), runMatchAutomation(T.afterCutoff)]);
    } finally {
      spy.mockRestore();
    }
    expect(testOutbox.sent.map((e) => e.to)).toEqual(["owner@example.test"]);
    await Promise.all([runMatchAutomation(T.afterCutoff), runMatchAutomation(T.afterCutoff), runMatchAutomation(T.afterCutoff)]);
    await runMatchAutomation(T.afterCutoff);
    expect(testOutbox.sent.map((e) => e.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    expect((await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } })).notifiedAt).not.toBeNull();
    expect(sends("stopPoll")).toBe(1);
  });

  it("a recipient claimed by a crashed run is retried only after the claim is stale (15 min)", async () => {
    const m = await toCutoff();
    const a = await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } });
    // A previous process claimed the ADMIN and died before recording the outcome.
    await prisma.matchAutomationEmail.create({ data: { automationId: a.id, userId: "u-admin", claimedAt: T.afterCutoff } });
    await runMatchAutomation(new Date(T.afterCutoff.getTime() + 60_000));
    expect(testOutbox.sent.map((e) => e.to)).toEqual(["owner@example.test"]);
    expect((await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } })).notifiedAt).toBeNull();
    await runMatchAutomation(new Date(T.afterCutoff.getTime() + 16 * 60_000));
    expect(testOutbox.sent.map((e) => e.to)).toEqual(["owner@example.test", "admin@example.test"]);
    expect((await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id } })).notifiedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------- catch-up semantics (durable due state)
  const POLL_DUE = new Date("2026-10-12T00:00:00Z"); // Sun 20:00 EDT
  const CUTOFF_DUE = new Date("2026-10-13T00:00:00Z"); // Mon 20:00 EDT
  const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

  it("a late trigger still posts the poll once: due 8:00 → runs at 8:15, 8:30 and 8:45 post exactly one poll", async () => {
    await setup();
    expect(await runMatchAutomation(plus(POLL_DUE, 15))).toMatchObject({ created: 1, pollsPosted: 1 });
    expect(await runMatchAutomation(plus(POLL_DUE, 30))).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(await runMatchAutomation(plus(POLL_DUE, 45))).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(sends("sendPoll")).toBe(1);
    expect(await scheduledMatches()).toHaveLength(1);
  });

  it("an outage of hours recovers: first run 22 h after the poll time (still before the cutoff) creates the Match and posts the poll once", async () => {
    await setup();
    expect(await runMatchAutomation(plus(POLL_DUE, 22 * 60))).toMatchObject({ created: 1, pollsPosted: 1 });
    await runMatchAutomation(plus(POLL_DUE, 22 * 60 + 15));
    expect(sends("sendPoll")).toBe(1);
  });

  it("a late cutoff is still processed once: due Mon 8:00 PM → first run 8:27 PM closes poll + attendance and emails once; 5 h later nothing repeats", async () => {
    const m = await toCutoff();
    expect(await runMatchAutomation(plus(CUTOFF_DUE, 27))).toMatchObject({ cutoffs: 1, notified: 1 });
    expect(await runMatchAutomation(plus(CUTOFF_DUE, 5 * 60))).toMatchObject({ cutoffs: 0, notified: 0, pollsPosted: 0 });
    expect(sends("stopPoll")).toBe(1);
    expect(sends("sendPoll")).toBe(1);
    expect(testOutbox.sent).toHaveLength(2);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m.id } })).attendanceClosedAt).toEqual(plus(CUTOFF_DUE, 27));
  });

  it("a cutoff missed for 47 h is caught up; one missed for more than 48 h is left to the organizer (shown) and Run now finishes it", async () => {
    let m = await toCutoff();
    expect(await runMatchAutomation(plus(CUTOFF_DUE, 47 * 60))).toMatchObject({ cutoffs: 1, notified: 1 });

    await seed();
    await signIn("owner");
    tgCalls = [];
    testOutbox.clear();
    m = await toCutoff();
    expect(await runMatchAutomation(plus(CUTOFF_DUE, 49 * 60))).toMatchObject({ cutoffs: 0, notified: 0 });
    expect(sends("stopPoll")).toBe(0);
    expect(testOutbox.sent).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(plus(CUTOFF_DUE, 49 * 60));
    try {
      expect(((await call(matchRoute.GET(json("GET"), gm(m.id)))).body.automation as Record<string, unknown>).catchUpExpired).toBe(true);
      expect((await call(automationRoute.POST(json("POST", {}), gm(m.id)))).body).toMatchObject({ cutoffs: 1, notified: 1 });
      expect(((await call(matchRoute.GET(json("GET"), gm(m.id)))).body.automation as Record<string, unknown>).catchUpExpired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(sends("stopPoll")).toBe(1);
    expect(sends("sendPoll")).toBe(1);
  });

  it("obsolete Match: a poll that never went out is NOT posted once the cutoff has passed, even after the problem is fixed", async () => {
    await setup();
    sendPollMode = "reject";
    await runMatchAutomation(T.afterPoll); // Telegram refused → poll pending
    const refused = sends("sendPoll");
    sendPollMode = "ok";
    await runMatchAutomation(plus(CUTOFF_DUE, 5));
    await runMatchAutomation(plus(CUTOFF_DUE, 5 * 24 * 60)); // days later (next week's poll window has not opened yet)
    expect(sends("sendPoll")).toBe(refused); // nothing after the cutoff
    const [m] = await scheduledMatches();
    expect(m.automation!.pollPostedAt).toBeNull();
    expect(m.automation!.cutoffCompletedAt).not.toBeNull(); // attendance still closed + organizers told
    expect(await scheduledMatches()).toHaveLength(1);
  });

  it("paused schedule and already-completed steps: nothing runs", async () => {
    const id = await setup();
    await runMatchAutomation(T.afterPoll);
    await runMatchAutomation(T.afterCutoff);
    const before = { polls: sends("sendPoll"), stops: sends("stopPoll"), emails: testOutbox.sent.length };
    expect(await runMatchAutomation(plus(CUTOFF_DUE, 60))).toMatchObject({ created: 0, pollsPosted: 0, cutoffs: 0, notified: 0 });
    await call(scheduleRoute.PATCH(json("PATCH", { isActive: false }), gs(id)));
    expect(await runMatchAutomation(new Date("2026-10-19T00:05:00Z"))).toMatchObject({ created: 0, pollsPosted: 0, cutoffs: 0, notified: 0 }); // next week's poll time
    expect({ polls: sends("sendPoll"), stops: sends("stopPoll"), emails: testOutbox.sent.length }).toEqual(before);
    expect(await scheduledMatches()).toHaveLength(1);
  });
  // ---------------------------------------------------------------- M9.2.1 — schedule automation controls
  const runNow = async (scheduleId: string, at: Date, slugs = A) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    try {
      return await call(scheduleRunRoute.POST(json("POST"), gs(scheduleId, slugs)));
    } finally {
      vi.useRealTimers();
    }
  };
  const pause = (id: string, isActive: boolean) => call(scheduleRoute.PATCH(json("PATCH", { isActive }), gs(id)));
  const isActive = async (id: string) => (await prisma.matchSchedule.findUniqueOrThrow({ where: { id } })).isActive;

  it("M9.2.1 — OWNER and ADMIN pause / resume; MEMBER cannot pause, resume, edit or Run Now; foreign schedules are 404", async () => {
    const id = await setup();
    expect((await pause(id, false)).body).toMatchObject({ ok: true, schedule: { isActive: false } });
    await signIn("admin");
    expect((await pause(id, true)).body).toMatchObject({ ok: true, schedule: { isActive: true } });
    expect((await pause(id, false)).status).toBe(200);
    expect((await pause(id, true)).status).toBe(200);
    await signIn("member");
    expect((await pause(id, false)).status).toBe(404);
    expect((await call(scheduleRoute.PATCH(json("PATCH", { startTime: "20:30" }), gs(id)))).status).toBe(404);
    expect((await runNow(id, T.afterPoll)).status).toBe(404);
    await signIn("other");
    expect((await runNow(id, T.afterPoll, B)).status).toBe(404); // another Organization's URL
    expect((await call(scheduleRoute.PATCH(json("PATCH", { isActive: false }), gs(id, B)))).status).toBe(404);
    await signIn("owner");
    expect((await runNow("does-not-exist", T.afterPoll)).status).toBe(404);
    expect(await isActive(id)).toBe(true);
    expect(await scheduledMatches()).toHaveLength(0); // nothing ran for the refused callers
    expect(tgCalls).toHaveLength(0);
  });

  it("M9.2.1 — paused: the automatic scheduler ignores it; resume restores automatic eligibility without duplicates", async () => {
    const id = await setup();
    await pause(id, false);
    expect(await runMatchAutomation(T.afterPoll)).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(await scheduledMatches()).toHaveLength(0);
    await pause(id, true);
    expect(await runMatchAutomation(plus(T.afterPoll, 15))).toMatchObject({ created: 1, pollsPosted: 1 });
    await pause(id, false);
    await pause(id, true);
    expect(await runMatchAutomation(plus(T.afterPoll, 30))).toMatchObject({ created: 0, pollsPosted: 0 });
    expect(await scheduledMatches()).toHaveLength(1);
    expect(sends("sendPoll")).toBe(1);
  });

  it("M9.2.1 — Run Now while paused runs that schedule once, keeps it paused, and repeated Run Now never duplicates the Match, poll, cutoff or email; teams never published", async () => {
    const id = await setup();
    await pause(id, false);
    // Nothing due yet → reported honestly.
    expect((await runNow(id, T.beforePoll)).body).toEqual({ ok: true, paused: true, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, issues: [] });
    expect((await runNow(id, T.afterPoll)).body).toMatchObject({ ok: true, paused: true, created: 1, pollsPosted: 1 });
    expect((await runNow(id, plus(T.afterPoll, 5))).body).toMatchObject({ ok: true, created: 0, pollsPosted: 0, cutoffs: 0, notified: 0 });
    expect(await isActive(id)).toBe(false);
    // The automatic scheduler still ignores the paused schedule at the cutoff.
    expect(await runMatchAutomation(T.afterCutoff)).toMatchObject({ cutoffs: 0, notified: 0 });
    expect(sends("stopPoll")).toBe(0);
    // Organizer finalizes it explicitly.
    expect((await runNow(id, T.afterCutoff)).body).toMatchObject({ ok: true, paused: true, cutoffs: 1, notified: 1 });
    for (const at of [T.afterCutoff, plus(T.afterCutoff, 60)]) expect((await runNow(id, at)).body).toMatchObject({ created: 0, pollsPosted: 0, cutoffs: 0, notified: 0, issues: [] });
    expect(await scheduledMatches()).toHaveLength(1);
    expect(sends("sendPoll")).toBe(1);
    expect(sends("stopPoll")).toBe(1);
    expect(testOutbox.sent.map((e) => e.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    expect(await isActive(id)).toBe(false);
    expect(await prisma.teamGeneration.count()).toBe(0);
    expect(sends("sendMessage")).toBe(0);
  });

  it("M9.2.1 — Run Now while active: same engine, idempotent; problems are reported in organizer terms", async () => {
    const id = await setup();
    sendPollMode = "reject";
    const first = (await runNow(id, T.afterPoll)).body;
    expect(first).toMatchObject({ ok: false, paused: false, created: 1, pollsPosted: 0 });
    expect(first.issues).toEqual([expect.stringMatching(/attendance poll could not be posted/)]);
    const refused = sends("sendPoll");
    sendPollMode = "ok";
    expect((await runNow(id, plus(T.afterPoll, 1))).body).toMatchObject({ ok: true, created: 0, pollsPosted: 1, issues: [] });
    expect((await runNow(id, plus(T.afterPoll, 2))).body).toMatchObject({ ok: true, created: 0, pollsPosted: 0 });
    expect(sends("sendPoll")).toBe(refused + 1);
    expect(await isActive(id)).toBe(true);
  });

  it("M9.2.1 — Run Now for one schedule never runs another (paused) schedule; match-level Run now works while paused", async () => {
    const id = await setup();
    const funnyChat = await prisma.telegramChat.create({ data: { chatId: -9800n, title: "Funny chat", groupId: "ga", communityId: "c-funny" } });
    const other = ((await call(schedulesRoute.POST(json("POST", { ...SCHED, communityId: "c-funny" }), g()))).body.schedule as { id: string }).id;
    await pause(other, false);
    expect((await runNow(id, T.afterPoll)).body).toMatchObject({ created: 1, pollsPosted: 1 });
    expect((await scheduledMatches()).map((m) => m.scheduleId)).toEqual([id]);
    expect(funnyChat.id).toBeTruthy();
    // Match-level Run now on a paused schedule's Match still runs it (and keeps it paused).
    await pause(id, false);
    const [m] = await scheduledMatches();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T.afterCutoff);
    try {
      expect((await call(automationRoute.POST(json("POST", {}), gm(m.id)))).body).toMatchObject({ ok: true, paused: true, cutoffs: 1, notified: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(await isActive(id)).toBe(false);
    expect(await scheduledMatches()).toHaveLength(1); // the paused FunnyStuff schedule created nothing
  });

  it("M9.2.1 — pausing never deletes the schedule, its Matches, attendance, polls or automation state", async () => {
    const id = await setup();
    await runMatchAutomation(T.afterPoll);
    const [m] = await scheduledMatches();
    await prisma.attendanceResponse.create({ data: { groupId: "ga", matchId: m.id, playerId: "u1", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: T.afterPoll } });
    await runMatchAutomation(T.afterCutoff);
    const snapshot = async () => ({
      schedules: await prisma.matchSchedule.count(),
      matches: await prisma.match.count(),
      automation: await prisma.matchAutomation.findUniqueOrThrow({ where: { matchId: m.id }, select: { pollPostedAt: true, cutoffCompletedAt: true, notifiedAt: true } }),
      attendance: await prisma.attendanceResponse.count({ where: { matchId: m.id } }),
      polls: await prisma.telegramPoll.count({ where: { matchId: m.id } }),
      emails: await prisma.matchAutomationEmail.count(),
      closed: (await prisma.match.findUniqueOrThrow({ where: { id: m.id } })).attendanceClosedAt,
    });
    const before = await snapshot();
    await pause(id, false);
    expect(await snapshot()).toEqual(before);
    await pause(id, true);
    expect(await snapshot()).toEqual(before);
  });
});

describe("M9.2-8 — player-facing surfaces respect the Match's Community", () => {
  it("My Games lists only the player's own Communities' matches; self-attendance is refused for another Community's match", async () => {
    await prisma.player.update({ where: { id: "f1" }, data: { userId: "u-member" } }); // FunnyStuff-only player
    const uccne = ((await createMatch({ communityId: "c-uccne", date: "2099-01-05" })).body.match as { id: string }).id;
    const funny = ((await createMatch({ communityId: "c-funny", date: "2099-01-06" })).body.match as { id: string }).id;
    const legacy = await prisma.match.create({ data: { groupId: "ga", date: new Date("2099-01-07") } });
    const [profile] = await loadMyGames("u-member", new Date("2098-12-30T00:00:00Z"));
    expect(profile.upcoming.map((g) => g.matchId)).toEqual([funny, legacy.id]);
    expect(await setOwnAttendance("u-member", uccne, "PLAYING")).toBe("not_found");
    expect(await setOwnAttendance("u-member", funny, "PLAYING")).toBe("ok");
    expect(await prisma.attendanceResponse.count({ where: { matchId: uccne } })).toBe(0);
  });
});
