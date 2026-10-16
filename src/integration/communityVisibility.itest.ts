/**
 * Community visibility on match lists + Community selection when adding /
 * editing a player — REAL DATABASE (guarded local test DB only). No Telegram,
 * no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import { loadGroupOverview } from "@/lib/groupOverview";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { matchAttendanceSnapshot } from "@/lib/attendanceSnapshot";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const json = (method: string, body: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const groupParams = (org = "o", group = "o-g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const playerParams = (id: string, org = "o", group = "o-g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, id }) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const NEW_PLAYER = { firstName: "New", lastName: "Player", position: "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: true };
const memberships = async (playerId: string) => (await prisma.communityPlayer.findMany({ where: { playerId }, select: { communityId: true }, orderBy: { communityId: "asc" } })).map((r) => r.communityId);

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const o of ["o", "x"]) {
    await prisma.organization.create({ data: { id: o, name: `Org ${o}`, slug: o, plan: "LEGACY" } });
    await prisma.group.create({ data: { id: `${o}-g`, organizationId: o, name: `${o} group`, slug: `${o}-g`, sportKey: "soccer", timezone: "America/New_York" } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "x", role: "OWNER" },
    ],
  });
  await prisma.community.createMany({
    data: [
      { id: "c-fc", groupId: "o-g", name: "UCCNE - FC (Indoor Soccer)" },
      { id: "c-wk", groupId: "o-g", name: "Weekend League" },
      { id: "c-old", groupId: "o-g", name: "Old Tuesdays", isActive: false },
      { id: "c-x", groupId: "x-g", name: "Other Org Community" },
    ],
  });
  signIn("owner");
});
afterAll(async () => {
  await prisma.$disconnect();
});

// ================================================================ community on match lists
describe("match lists show the Match's own Community before the venue", () => {
  it("upcoming and past matches carry their linked Community; none → null (shown as 'No community assigned')", async () => {
    await prisma.match.createMany({
      data: [
        { id: "up-fc", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), startTime: "21:00", locationName: "ForeKicks", communityId: "c-fc" },
        { id: "up-none", groupId: "o-g", date: new Date("2099-06-10T00:00:00Z"), startTime: "21:00", locationName: "ForeKicks" },
        { id: "past-wk", groupId: "o-g", date: new Date("2020-06-03T00:00:00Z"), startTime: "10:00", locationName: "Field 2", communityId: "c-wk", status: "COMPLETED" },
        { id: "past-old", groupId: "o-g", date: new Date("2020-05-03T00:00:00Z"), startTime: "10:00", locationName: "Field 3", communityId: "c-old", status: "COMPLETED" },
      ],
    });
    const overview = await loadGroupOverview(await requireTenantContextForSlugs({ organizationSlug: "o", groupSlug: "o-g" }));
    const byId = Object.fromEntries([...overview.upcoming, ...overview.past].map((m) => [m.id, m]));
    expect(byId["up-fc"]).toMatchObject({ communityName: "UCCNE - FC (Indoor Soccer)", locationName: "ForeKicks", upcoming: true });
    expect(byId["up-none"]).toMatchObject({ communityName: null, upcoming: true });
    expect(byId["past-wk"]).toMatchObject({ communityName: "Weekend League", upcoming: false });
    expect(byId["past-old"]).toMatchObject({ communityName: "Old Tuesdays" }); // historical match keeps its (now inactive) Community
    expect(overview.focus?.match).toMatchObject({ id: "up-fc", communityName: "UCCNE - FC (Indoor Soccer)" }); // the Next/Latest match card
  });

  it("it is the Match's own Community — not the Telegram chat's or another Group's", async () => {
    await prisma.telegramChat.create({ data: { chatId: -100n, title: "Chat", groupId: "o-g", communityId: "c-wk" } });
    const chat = await prisma.telegramChat.findFirstOrThrow({ where: { chatId: -100n } });
    await prisma.match.create({ data: { id: "m", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), communityId: "c-fc", telegramChatId: chat.id } });
    const overview = await loadGroupOverview(await requireTenantContextForSlugs({ organizationSlug: "o", groupSlug: "o-g" }));
    expect(overview.upcoming[0].communityName).toBe("UCCNE - FC (Indoor Soccer)");
    signIn("other");
    const other = await loadGroupOverview(await requireTenantContextForSlugs({ organizationSlug: "x", groupSlug: "x-g" }));
    expect(other.upcoming).toEqual([]);
  });
});

// ================================================================ Add Player with Communities
describe("Add Player: Community memberships", () => {
  it("creates the player and ALL chosen memberships together; duplicates are ignored", async () => {
    const r = await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc", "c-wk", "c-fc"] }), groupParams()));
    expect(r.status).toBe(200);
    const id = String(r.body.id);
    expect(await memberships(id)).toEqual(["c-fc", "c-wk"]);
    expect((r.body.communityIds as string[]).sort()).toEqual(["c-fc", "c-wk"]);
    expect(await prisma.player.findUniqueOrThrow({ where: { id } })).toMatchObject({ firstName: "New", position: "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: true, groupId: "o-g" });
  });

  it("without communityIds: exactly the previous behavior (no memberships)", async () => {
    const r = await call(playersRoute.POST(json("POST", NEW_PLAYER), groupParams()));
    expect(r.status).toBe(200);
    expect(await memberships(String(r.body.id))).toEqual([]);
    expect(r.body.communityIds).toEqual([]);
  });

  it.each([
    ["another Organization's Community", ["c-fc", "c-x"]],
    ["an unknown Community", ["nope"]],
    ["an inactive Community", ["c-old"]],
  ])("%s → 400 and NOTHING is created (atomic)", async (_n, communityIds) => {
    const before = await prisma.player.count();
    const r = await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds }), groupParams()));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ issues: { fieldErrors: { communityIds: [expect.any(String)] } } });
    expect(await prisma.player.count()).toBe(before);
    expect(await prisma.communityPlayer.count()).toBe(0);
  });

  it("permissions + tenant isolation: MEMBER → 404; another Group's URL can't use this Group's Communities", async () => {
    signIn("member");
    expect((await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc"] }), groupParams()))).status).toBe(404);
    signIn("other");
    expect((await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc"] }), groupParams("x", "x-g")))).status).toBe(400);
    signIn("admin");
    expect((await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc"] }), groupParams()))).status).toBe(200);
    expect(await prisma.communityPlayer.count()).toBe(1);
  });

  it("the new player is in the chosen Community's attendance roster only", async () => {
    await prisma.match.createMany({
      data: [
        { id: "m-fc", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), communityId: "c-fc" },
        { id: "m-wk", groupId: "o-g", date: new Date("2099-06-04T00:00:00Z"), communityId: "c-wk" },
      ],
    });
    const r = await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc"] }), groupParams()));
    const id = String(r.body.id);
    expect((await matchAttendanceSnapshot("o-g", "m-fc"))!.eligibleIds).toContain(id);
    expect((await matchAttendanceSnapshot("o-g", "m-fc"))!.counts.NO_RESPONSE).toBe(1);
    expect((await matchAttendanceSnapshot("o-g", "m-wk"))!.eligibleIds).not.toContain(id);
  });

  it("plan limits are still enforced (no player, no memberships)", async () => {
    await prisma.organization.update({ where: { id: "o" }, data: { plan: "FREE", trialEndsAt: null } });
    await prisma.player.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, groupId: "o-g", firstName: "P", lastName: String(i), position: "MIDFIELDER", rating: "GOOD", stamina: 3 })) });
    const r = await call(playersRoute.POST(json("POST", { ...NEW_PLAYER, communityIds: ["c-fc"] }), groupParams()));
    expect(r.status).toBe(402);
    expect(await prisma.player.count()).toBe(30);
    expect(await prisma.communityPlayer.count()).toBe(0);
  });
});

// ================================================================ Edit Player memberships
describe("Edit Player: Community memberships", () => {
  beforeEach(async () => {
    await prisma.player.create({ data: { id: "p1", groupId: "o-g", firstName: "Pat", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 4 } });
    await prisma.communityPlayer.createMany({ data: ["c-fc", "c-old"].map((communityId) => ({ groupId: "o-g", communityId, playerId: "p1" })) });
  });

  it("communityIds omitted → memberships untouched (other fields saved)", async () => {
    const r = await call(playerRoute.PATCH(json("PATCH", { firstName: "Patricia" }), playerParams("p1")));
    expect(r.status).toBe(200);
    expect(await memberships("p1")).toEqual(["c-fc", "c-old"]);
    expect(await prisma.player.findUniqueOrThrow({ where: { id: "p1" } })).toMatchObject({ firstName: "Patricia", position: "DEFENDER", stamina: 4 });
  });

  it("communityIds = the complete desired set: adds and removes atomically with the field changes", async () => {
    const r = await call(playerRoute.PATCH(json("PATCH", { lastName: "Uno", communityIds: ["c-wk", "c-old"] }), playerParams("p1")));
    expect(r.status).toBe(200);
    expect(await memberships("p1")).toEqual(["c-old", "c-wk"]); // c-fc removed, c-wk added, inactive c-old kept
    expect((r.body.communityIds as string[]).sort()).toEqual(["c-old", "c-wk"]);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p1" } })).lastName).toBe("Uno");
    expect((await call(playerRoute.PATCH(json("PATCH", { communityIds: [] }), playerParams("p1")))).status).toBe(200);
    expect(await memberships("p1")).toEqual([]);
  });

  it("an invalid choice changes NOTHING (fields and memberships), and adding to an inactive Community is refused", async () => {
    await prisma.communityPlayer.deleteMany({ where: { playerId: "p1", communityId: "c-old" } });
    for (const communityIds of [["c-fc", "c-x"], ["c-old"]]) {
      const r = await call(playerRoute.PATCH(json("PATCH", { firstName: "Changed", communityIds }), playerParams("p1")));
      expect(r.status).toBe(400);
    }
    expect(await memberships("p1")).toEqual(["c-fc"]);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p1" } })).firstName).toBe("Pat");
  });

  it("tenant isolation + permissions: another Group's URL → 404 (nothing changed); MEMBER → 404", async () => {
    signIn("other");
    expect((await call(playerRoute.PATCH(json("PATCH", { communityIds: [] }), playerParams("p1", "x", "x-g")))).status).toBe(404);
    signIn("member");
    expect((await call(playerRoute.PATCH(json("PATCH", { communityIds: [] }), playerParams("p1")))).status).toBe(404);
    expect(await memberships("p1")).toEqual(["c-fc", "c-old"]);
  });

  it("the players list reflects the new memberships", async () => {
    await call(playerRoute.PATCH(json("PATCH", { communityIds: ["c-fc", "c-wk"] }), playerParams("p1")));
    const list = (await (await playersRoute.GET(new Request("http://itest.local/"), groupParams())).json()) as Array<{ id: string; communityIds: string[] }>;
    const p1 = list.find((p) => p.id === "p1")!;
    expect(p1.communityIds.sort()).toEqual(["c-fc", "c-wk"]);
  });
});

// ================================================================ Overview card attendance = Match Workspace
describe("Overview Next / Latest match card: the same attendance numbers as the Match Workspace", () => {
  // a: FC only · b: Weekend only · c: FC + Weekend · d: no Community · e: FC but INACTIVE · f: FC, then REMOVED from FC
  beforeEach(async () => {
    await prisma.player.createMany({
      data: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, groupId: "o-g", firstName: id.toUpperCase(), lastName: "X", position: "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: id !== "e" })),
    });
    await prisma.communityPlayer.createMany({
      data: [
        ["c-fc", "a"], ["c-wk", "b"], ["c-fc", "c"], ["c-wk", "c"], ["c-fc", "e"], ["c-fc", "f"],
      ].map(([communityId, playerId]) => ({ groupId: "o-g", communityId, playerId })),
    });
  });
  const answers = async (matchId: string) => {
    const at = new Date("2026-10-01T12:00:00Z");
    await prisma.attendanceResponse.createMany({
      data: [
        { playerId: "a", participantStatus: "PLAYING" as const },
        { playerId: "b", participantStatus: "NOT_PLAYING" as const },
        { playerId: "c", participantStatus: "MAYBE" as const },
        { playerId: "d", participantStatus: "PLAYING" as const },
        { playerId: "e", participantStatus: "PLAYING" as const },
      ].map((r) => ({ ...r, matchId, groupId: "o-g", participantSource: "WEB" as const, participantRespondedAt: at })),
    });
  };
  const workspace = async (matchId: string) => {
    const body = (await (await matchRoute.GET(new Request("http://itest.local/"), { params: Promise.resolve({ organizationSlug: "o", groupSlug: "o-g", matchId }) })).json()) as { counts: Record<string, number>; rosterSize: number };
    return body;
  };
  const card = async () => (await loadGroupOverview(await requireTenantContextForSlugs({ organizationSlug: "o", groupSlug: "o-g" }))).focus!;
  const total = (c: Record<string, number>) => c.PLAYING + c.NOT_PLAYING + c.MAYBE + c.NO_RESPONSE;

  it("a Community match (multiple Communities in the group): only that Community's active members, each once", async () => {
    await prisma.match.create({ data: { id: "m", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), communityId: "c-fc" } });
    await answers("m");
    // FC roster: a (Playing), c (Maybe — also in Weekend, counted once), f (no answer); e inactive; b, d not members.
    const expected = { PLAYING: 1, NOT_PLAYING: 0, MAYBE: 1, NO_RESPONSE: 1 };
    const f = await card();
    expect(f).toMatchObject({ kind: "next", match: { id: "m", communityName: "UCCNE - FC (Indoor Soccer)" } });
    expect(f.counts).toEqual(expected);
    const w = await workspace("m");
    expect(w.counts).toEqual(expected);
    expect(total(f.counts)).toBe(w.rosterSize);
    // f removed from FC → leaves the roster (card and workspace alike).
    await prisma.communityPlayer.deleteMany({ where: { communityId: "c-fc", playerId: "f" } });
    expect((await card()).counts).toEqual({ PLAYING: 1, NOT_PLAYING: 0, MAYBE: 1, NO_RESPONSE: 0 });
    expect((await workspace("m")).counts).toEqual((await card()).counts);
  });

  it("the other Community's match counts its own members (a player in both Communities counts in each)", async () => {
    await prisma.match.create({ data: { id: "m", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), communityId: "c-wk" } });
    await answers("m");
    const f = await card();
    expect(f.counts).toEqual({ PLAYING: 0, NOT_PLAYING: 1, MAYBE: 1, NO_RESPONSE: 0 }); // b Not playing, c Maybe
    expect((await workspace("m")).counts).toEqual(f.counts);
  });

  it("a match without a Community keeps the whole-group fallback (every ACTIVE player)", async () => {
    await prisma.match.create({ data: { id: "m", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z") } });
    await answers("m");
    const f = await card();
    expect(f.match.communityName).toBeNull();
    expect(f.counts).toEqual({ PLAYING: 2, NOT_PLAYING: 1, MAYBE: 1, NO_RESPONSE: 1 }); // a, d · b · c · f (e inactive)
    const w = await workspace("m");
    expect(w.counts).toEqual(f.counts);
    expect(w.rosterSize).toBe(5);
  });

  it("the Latest (past) match card uses the same calculation", async () => {
    await prisma.match.create({ data: { id: "p", groupId: "o-g", date: new Date("2020-06-03T00:00:00Z"), communityId: "c-fc" } });
    await answers("p");
    await prisma.player.update({ where: { id: "a" }, data: { isActive: false } }); // deactivated after answering
    const f = await card();
    expect(f).toMatchObject({ kind: "latest", match: { id: "p" } });
    expect(f.counts).toEqual({ PLAYING: 0, NOT_PLAYING: 0, MAYBE: 1, NO_RESPONSE: 1 }); // c, f
    expect((await workspace("p")).counts).toEqual(f.counts);
  });
});
