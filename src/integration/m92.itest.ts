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

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = "2026-10-12";

// ------------------------------------------------------------ network guard (Telegram stub)
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
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
});
beforeEach(async () => {
  session = null;
  tgCalls = [];
  otherNetwork = 0;
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
