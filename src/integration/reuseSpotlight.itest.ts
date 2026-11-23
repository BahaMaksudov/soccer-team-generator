/**
 * Reuse previous teams + Random Player Spotlight — REAL-DATABASE tests (guarded local TEST
 * database only). Telegram is a stub; no other network access is allowed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as reuseRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/reuse-teams/route";
import * as spotlightRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/spotlight/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as swapRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/swap/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as deliveryRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/delivery/route";
import { selectSpotlight } from "@/lib/spotlight";
import { confirmedAttendeeIds } from "@/lib/attendanceSnapshot";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const A2 = { organizationSlug: "org-a", groupSlug: "group-a2" };
const g = (x: typeof A) => ({ params: Promise.resolve(x) });
const gm = (x: typeof A, matchId: string) => ({ params: Promise.resolve({ ...x, matchId }) });
const json = (method: string, body?: unknown, url = "http://itest.local/") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (p: Promise<Response> | Response) => {
  const r = await p;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// ---------------------------------------------------------------- Telegram stub
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let pollSeq = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) }) as unknown as Response;
  if (method === "sendPoll") return ok({ message_id: 100 + ++pollSeq, poll: { id: `tg-poll-${pollSeq}` } });
  return ok({ message_id: 1 });
}
const sentTexts = () => tgCalls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));

// ---------------------------------------------------------------- fixtures
async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
}
const PLAYERS: Array<[string, string, string, string]> = [
  ["p1", "Ana", "One", "GOALKEEPER"],
  ["p2", "Ben", "Two", "DEFENDER"],
  ["p3", "Cai", "Three", "MIDFIELDER"],
  ["p4", "Dee", "Four", "FORWARD"],
  ["p5", "Alex", "Kim", "DEFENDER"],
  ["p6", "Alex", "Kim", "FORWARD"], // same name, different person
];
async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "SpotlightPick","SpotlightRotation","SpotlightCommunityRotation","CommunityPlayer","Community","AttendanceResponse","MessageDelivery","TelegramPollAnswer","TelegramPoll","TelegramChat","Match","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  for (const email of ["owner@example.test", "admin@example.test", "member@example.test", "owner-b@example.test"]) {
    await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: verified } });
  }
  const id = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  await prisma.organization.createMany({ data: [{ id: "org-a-id", name: "Org A", slug: "org-a", plan: "LEGACY" }, { id: "org-b-id", name: "Org B", slug: "org-b", plan: "LEGACY" }] });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: await id("owner@example.test"), organizationId: "org-a-id", role: "OWNER" },
      { userId: await id("admin@example.test"), organizationId: "org-a-id", role: "ADMIN" },
      { userId: await id("member@example.test"), organizationId: "org-a-id", role: "MEMBER" },
      { userId: await id("owner-b@example.test"), organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  await prisma.group.create({ data: { id: "ga", organizationId: "org-a-id", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC", visibility: "PUBLIC" } });
  await prisma.group.create({ data: { id: "ga2", organizationId: "org-a-id", name: "Group A2", slug: "group-a2", sportKey: "soccer", timezone: "UTC" } });
  await prisma.group.create({ data: { id: "gb", organizationId: "org-b-id", name: "Group B", slug: "group-b", sportKey: "soccer", timezone: "UTC" } });
  for (const [pid, first, last, pos] of PLAYERS) await prisma.player.create({ data: { id: pid, groupId: "ga", firstName: first, lastName: last, position: pos as never, rating: "GOOD", stamina: 3 } });
  for (const pid of ["a2p1", "a2p2"]) await prisma.player.create({ data: { id: pid, groupId: "ga2", firstName: pid, lastName: "X", position: "FORWARD", rating: "GOOD", stamina: 3 } });
  for (const pid of ["bp1", "bp2"]) await prisma.player.create({ data: { id: pid, groupId: "gb", firstName: pid, lastName: "X", position: "FORWARD", rating: "GOOD", stamina: 3 } });
  await prisma.telegramChat.create({ data: { chatId: -1001n, title: "Group A chat", groupId: "ga" } });
}
let matchSeq = 0;
async function match(groupId = "ga", date = "2026-11-20") {
  return (await prisma.match.create({ data: { id: `m${++matchSeq}`, groupId, date: new Date(`${date}T00:00:00Z`), startTime: "19:00" } })).id;
}
async function attend(matchId: string, playing: string[], groupId = "ga", status: "PLAYING" | "NOT_PLAYING" | "MAYBE" = "PLAYING") {
  for (const playerId of playing) {
    await prisma.attendanceResponse.upsert({
      where: { matchId_playerId: { matchId, playerId } },
      update: { participantStatus: status, participantSource: "WEB", participantRespondedAt: new Date() },
      create: { matchId, groupId, playerId, participantStatus: status, participantSource: "WEB", participantRespondedAt: new Date() },
    });
  }
}
async function publishFor(matchId: string, teams: unknown, date = "2026-11-20", grp = A, extra: Record<string, unknown> = {}) {
  return call(publishRoute.POST(json("POST", { date, teams, matchId, ...extra }), g(grp)));
}
const reuseList = (matchId: string, grp = A) => call(reuseRoute.GET(json("GET"), gm(grp, matchId)));
const reusePlan = (matchId: string, source: string, grp = A) => call(reuseRoute.GET(json("GET", undefined, `http://itest.local/?source=${source}`), gm(grp, matchId)));
const reuseBuild = (matchId: string, body: unknown, grp = A) => call(reuseRoute.POST(json("POST", body), gm(grp, matchId)));
const spot = (matchId: string, action: "select" | "replace", grp = A) => call(spotlightRoute.POST(json("POST", { action }), gm(grp, matchId)));
const spotView = (matchId: string, grp = A) => call(spotlightRoute.GET(json("GET"), gm(grp, matchId)));
const spotNote = (matchId: string, note: unknown) => call(spotlightRoute.PATCH(json("PATCH", { note }), gm(A, matchId)));

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
});
beforeEach(async () => {
  session = null;
  tgCalls = [];
  otherNetwork = 0;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "");
  await seed();
  await signInAs("owner@example.test");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ============================================================================ Feature A
describe("Reuse previous teams", () => {
  const PREV = [
    { teamNumber: 1, shirtColor: "purple", players: [{ id: "p1" }, { id: "p2" }, { id: "p5" }] },
    { teamNumber: 2, shirtColor: "white", players: [{ id: "p3" }, { id: "p4" }] },
  ];
  async function previousMatch(teams: unknown = PREV, date = "2026-11-13") {
    const id = await match("ga", date);
    expect((await publishFor(id, teams, date)).status).toBe(200);
    return { id, gen: await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } }) };
  }

  it("lists this group's earlier publications newest first — never this match's own or another group's", async () => {
    const older = await previousMatch(PREV, "2026-11-06");
    const newer = await previousMatch(PREV, "2026-11-13");
    const current = await match();
    await publishFor(current, PREV);
    // Another group's publication must not appear.
    const otherMatch = await match("ga2");
    expect((await publishFor(otherMatch, [{ teamNumber: 1, players: [{ id: "a2p1" }] }, { teamNumber: 2, players: [{ id: "a2p2" }] }], "2026-11-20", A2)).status).toBe(200);
    const r = await reuseList(current);
    expect(r.status).toBe(200);
    expect(r.body.sources.map((s: { id: string }) => s.id)).toEqual([newer.gen.id, older.gen.id]);
    expect(r.body.sources[0]).toMatchObject({ date: "2026-11-13", teamCount: 2, playerCount: 5, hasShirtColors: true });
  });

  it("empty state: no earlier publications", async () => {
    expect((await reuseList(await match())).body.sources).toEqual([]);
  });

  it("same attendance: every player keeps their team and shirt color", async () => {
    const prev = await previousMatch();
    const id = await match();
    await attend(id, ["p1", "p2", "p3", "p4", "p5"]);
    const plan = await reusePlan(id, prev.gen.id);
    expect(plan.status).toBe(200);
    expect(plan.body.teams.map((t: { shirtColor: string; players: Array<{ id: string }> }) => [t.shirtColor, t.players.map((p) => p.id)])).toEqual([
      ["purple", ["p1", "p2", "p5"]],
      ["white", ["p3", "p4"]],
    ]);
    expect(plan.body.absent).toEqual([]);
    expect(plan.body.unassigned).toEqual([]);
  });

  it("absent + new + duplicate names: matched by id, absent left out, every new attendee must be placed", async () => {
    const prev = await previousMatch();
    const id = await match();
    await attend(id, ["p1", "p3", "p4", "p6"]); // p2, p5 absent; p6 (another "Alex Kim") is new
    await attend(id, ["p2"], "ga", "MAYBE"); // MAYBE is never confirmed
    const plan = await reusePlan(id, prev.gen.id);
    expect(plan.body.teams.map((t: { players: Array<{ id: string }> }) => t.players.map((p) => p.id))).toEqual([["p1"], ["p3", "p4"]]);
    expect(plan.body.absent.map((p: { id: string }) => p.id).sort()).toEqual(["p2", "p5"]);
    expect(plan.body.unassigned.map((p: { id: string }) => p.id)).toEqual(["p6"]); // never merged with p5 by name

    expect((await reuseBuild(id, { sourceId: prev.gen.id, placements: {} })).status).toBe(400); // can't omit a confirmed player
    expect((await reuseBuild(id, { sourceId: prev.gen.id, placements: { p6: 9 } })).status).toBe(400); // no such team
    expect((await reuseBuild(id, { sourceId: prev.gen.id, placements: { p6: 1, p2: 1 } })).status).toBe(400); // p2 isn't confirmed
    const built = await reuseBuild(id, { sourceId: prev.gen.id, placements: { p6: 1 } });
    expect(built.status).toBe(200);
    expect(built.body.teams.map((t: { teamNumber: number; shirtColor: string; players: Array<{ id: string }> }) => [t.teamNumber, t.shirtColor, t.players.map((p) => p.id)])).toEqual([
      [1, "purple", ["p1", "p6"]],
      [2, "white", ["p3", "p4"]],
    ]);
    expect(built.body.analysis).toMatchObject({ analysisVersion: expect.any(String), quality: expect.any(String) });
    expect(built.body.metrics.teams.map((t: { size: number }) => t.size)).toEqual([2, 2]);
    expect(built.body.reusedFromGenerationId).toBe(prev.gen.id);
  });

  it("publish stores provenance; the source publication is never changed; reload shows the reused teams + colors; a normal publish clears provenance", async () => {
    const prev = await previousMatch();
    const id = await match();
    await attend(id, ["p1", "p2", "p3", "p4", "p5"]);
    const built = await reuseBuild(id, { sourceId: prev.gen.id, placements: {} });
    // The organizer may still change a color before publishing.
    const teams = built.body.teams.map((t: { teamNumber: number }) => (t.teamNumber === 2 ? { ...t, shirtColor: "green" } : t));
    expect((await publishFor(id, teams, "2026-11-20", A, { reusedFromGenerationId: prev.gen.id })).status).toBe(200);
    const row = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } });
    expect(row.reusedFromGenerationId).toBe(prev.gen.id);
    expect(JSON.parse(row.teamsJson).map((t: { shirtColor: string }) => t.shirtColor)).toEqual(["purple", "green"]);
    const source = await prisma.teamGeneration.findUniqueOrThrow({ where: { id: prev.gen.id } });
    expect([source.teamsJson, source.updatedAt.getTime()]).toEqual([prev.gen.teamsJson, prev.gen.updatedAt.getTime()]);
    const v = await (await matchRoute.GET(json("GET"), gm(A, id))).json();
    expect(v.generation.teams.map((t: { shirtColor: string }) => t.shirtColor)).toEqual(["purple", "green"]);

    // Regenerate → publish normally: provenance cleared (same row).
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-11-20", selectedIds: ["p1", "p2", "p3", "p4"], matchId: id }), g(A))).json();
    expect((await publishFor(id, gen.teams)).status).toBe(200);
    expect((await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } })).reusedFromGenerationId).toBeNull();
  });

  it("Apply Swap works on reused teams (the usual server-checked suggestion)", async () => {
    const prev = await previousMatch([
      { teamNumber: 1, shirtColor: "red", players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
      { teamNumber: 2, shirtColor: "blue", players: [{ id: "p4" }, { id: "p5" }, { id: "p6" }] },
    ]);
    const id = await match();
    await attend(id, ["p1", "p2", "p3", "p4", "p5", "p6"]);
    const built = await reuseBuild(id, { sourceId: prev.gen.id, placements: {} });
    const swap = built.body.analysis.bestSwap;
    if (swap) {
      const r = await call(swapRoute.POST(json("POST", { teams: built.body.teams.map((t: { teamNumber: number; players: Array<{ id: string }> }) => ({ teamNumber: t.teamNumber, playerIds: t.players.map((p) => p.id) })), swap: { playerA: swap.playerA, playerB: swap.playerB } }), g(A)));
      expect(r.status).toBe(200);
    } else {
      expect(built.body.analysis.improvable).toBe(false);
    }
  });

  it("older publications without saved colors get the default order", async () => {
    const prev = await previousMatch([
      { teamNumber: 1, players: [{ id: "p1" }] },
      { teamNumber: 2, players: [{ id: "p2" }] },
    ]);
    // Make it a real legacy row (published before shirt colors existed).
    await prisma.teamGeneration.update({ where: { id: prev.gen.id }, data: { teamsJson: JSON.stringify(JSON.parse(prev.gen.teamsJson).map(({ shirtColor: _c, ...t }: { shirtColor?: string }) => t)) } });
    const id = await match();
    await attend(id, ["p1", "p2"]);
    expect((await reuseList(id)).body.sources[0].hasShirtColors).toBe(false);
    expect((await reusePlan(id, prev.gen.id)).body.teams.map((t: { shirtColor: string }) => t.shirtColor)).toEqual(["yellow", "blue"]);
  });

  it("no confirmed attendance → nothing to reuse (409); never a roster built from nobody", async () => {
    const prev = await previousMatch();
    const id = await match();
    expect(await reusePlan(id, prev.gen.id)).toMatchObject({ status: 409, body: { code: "NO_CONFIRMED" } });
    expect((await reuseBuild(id, { sourceId: prev.gen.id, placements: {} })).status).toBe(409);
  });

  it("tenant isolation: MEMBER, another organization, another group's source, another group's match → 404", async () => {
    const prev = await previousMatch();
    const id = await match();
    await attend(id, ["p1"]);
    await signInAs("member@example.test");
    expect((await reuseList(id)).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await reuseList(id)).status).toBe(404); // org A URL, org B user
    expect((await reuseList(id, B)).status).toBe(404); // org B URL, org A match
    await signInAs("owner@example.test");
    const otherGroupMatch = await match("ga2");
    await publishFor(otherGroupMatch, [{ teamNumber: 1, players: [{ id: "a2p1" }] }], "2026-11-20", A2);
    const foreignGen = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: otherGroupMatch } });
    expect((await reusePlan(id, foreignGen.id)).status).toBe(404); // a source of another group is "not found"
    expect((await reuseBuild(id, { sourceId: foreignGen.id, placements: {} })).status).toBe(404);
    // Provenance pointing at another group's row is REJECTED before any write (never stored).
    await attend(id, ["p1", "p2", "p3", "p4", "p5"]);
    const built = await reuseBuild(id, { sourceId: prev.gen.id, placements: {} });
    const forged = await publishFor(id, built.body.teams, "2026-11-20", A, { reusedFromGenerationId: foreignGen.id });
    expect(forged.status).toBe(400);
    expect(await prisma.teamGeneration.findUnique({ where: { matchId: id } })).toBeNull();
  });
});

// ============================================================================ Community scope
// Two Communities of ONE Group (the owner's FunnyStuff vs UCCNE - FC case). p3 and p4 belong to both.
const FUN = ["p1", "p2", "p3", "p4"];
const FC = ["p3", "p4", "p5", "p6"];
async function communities() {
  await prisma.community.create({ data: { id: "c-fun", groupId: "ga", name: "FunnyStuff" } });
  await prisma.community.create({ data: { id: "c-fc", groupId: "ga", name: "UCCNE - FC" } });
  for (const playerId of FUN) await prisma.communityPlayer.create({ data: { groupId: "ga", communityId: "c-fun", playerId } });
  for (const playerId of FC) await prisma.communityPlayer.create({ data: { groupId: "ga", communityId: "c-fc", playerId } });
}
async function cmatch(communityId: string | null, date = "2026-11-20") {
  const id = await match("ga", date);
  if (communityId) await prisma.match.update({ where: { id }, data: { communityId } });
  return id;
}
const two = (a: string[], colors = ["yellow", "blue"]) => [
  { teamNumber: 1, shirtColor: colors[0], players: a.slice(0, 2).map((id) => ({ id })) },
  { teamNumber: 2, shirtColor: colors[1], players: a.slice(2, 4).map((id) => ({ id })) },
];
async function published(communityId: string | null, date: string, ids: string[]) {
  const id = await cmatch(communityId, date);
  await attend(id, ids);
  expect((await publishFor(id, two(ids), date)).status).toBe(200);
  return (await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } })).id;
}
const first = () => 0; // deterministic draw: the first id of the sorted pool

describe("Community scope — Reuse previous teams", () => {
  let funGen: string, fcGen: string, wgGen: string, legacyGen: string;
  beforeEach(async () => {
    await communities();
    funGen = await published("c-fun", "2026-11-10", FUN);
    fcGen = await published("c-fc", "2026-11-11", FC);
    wgGen = await published(null, "2026-11-12", ["p1", "p5", "p2", "p6"]);
    // A legacy by-date publication (no Match, so no Community identity).
    expect((await call(publishRoute.POST(json("POST", { date: "2026-11-01", teams: two(["p1", "p3", "p5", "p6"]) }), g(A)))).status).toBe(200);
    legacyGen = (await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "ga", matchId: null } })).id;
  });

  it("a FunnyStuff match lists only FunnyStuff publications; UCCNE - FC only its own; whole-group only community-less ones", async () => {
    const funNow = await cmatch("c-fun");
    const fun = await reuseList(funNow);
    expect(fun.status).toBe(200);
    expect(fun.body.sources.map((x: { id: string }) => x.id)).toEqual([funGen]);
    expect(fun.body.communityName).toBe("FunnyStuff");
    expect(fun.body.sources[0]).toMatchObject({ date: "2026-11-10", startTime: "19:00", teamCount: 2, playerCount: 4, hasShirtColors: true });

    const fc = await reuseList(await cmatch("c-fc"));
    expect(fc.body.sources.map((x: { id: string }) => x.id)).toEqual([fcGen]);
    expect(fc.body.communityName).toBe("UCCNE - FC");

    const wg = await reuseList(await cmatch(null));
    expect(wg.body.sources.map((x: { id: string }) => x.id)).toEqual([wgGen, legacyGen]); // newest first
    expect(wg.body.communityName).toBeNull();
  });

  it("forged source ids of another community, a whole-group match or a legacy publication are rejected by the server", async () => {
    const funNow = await cmatch("c-fun");
    await attend(funNow, FUN);
    for (const forged of [fcGen, wgGen, legacyGen]) {
      expect((await reusePlan(funNow, forged)).status).toBe(404);
      expect((await reuseBuild(funNow, { sourceId: forged, placements: {} })).status).toBe(404);
    }
    const ok = await reuseBuild(funNow, { sourceId: funGen, placements: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.teams.map((t: { shirtColor: string }) => t.shirtColor)).toEqual(["yellow", "blue"]); // colors carried over

    // Publish re-checks the provenance: another community's id is refused before any write.
    const forged = await publishFor(funNow, ok.body.teams, "2026-11-20", A, { reusedFromGenerationId: fcGen });
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe("REUSE_SOURCE_NOT_IN_SCOPE");
    expect(await prisma.teamGeneration.findUnique({ where: { matchId: funNow } })).toBeNull();
    expect((await publishFor(funNow, ok.body.teams, "2026-11-20", A, { reusedFromGenerationId: funGen })).status).toBe(200);
    expect((await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: funNow } })).reusedFromGenerationId).toBe(funGen);

    // A whole-group match can't reuse a community's publication either.
    const wgNow = await cmatch(null);
    await attend(wgNow, FUN);
    expect((await reusePlan(wgNow, funGen)).status).toBe(404);
    expect((await reusePlan(wgNow, legacyGen)).status).toBe(200);
  });

  it("reconciliation still works inside the community: absent left out, a new member must be placed", async () => {
    await prisma.communityPlayer.create({ data: { groupId: "ga", communityId: "c-fun", playerId: "p5" } });
    const funNow = await cmatch("c-fun");
    await attend(funNow, ["p1", "p2", "p3", "p5"]); // p4 absent, p5 new
    const plan = await reusePlan(funNow, funGen);
    expect(plan.status).toBe(200);
    expect(plan.body.absent.map((x: { id: string }) => x.id)).toEqual(["p4"]);
    expect(plan.body.unassigned.map((x: { id: string }) => x.id)).toEqual(["p5"]);
    expect((await reuseBuild(funNow, { sourceId: funGen, placements: {} })).status).toBe(400); // must place p5
    const built = await reuseBuild(funNow, { sourceId: funGen, placements: { p5: 2 } });
    expect(built.status).toBe(200);
    expect(built.body.teams[1].players.map((x: { id: string }) => x.id)).toEqual(["p3", "p5"]);
  });
});

describe("Community scope — Random Player Spotlight", () => {
  beforeEach(communities);
  const progress = async (matchId: string) => (await spotView(matchId)).body.progress;

  it("cycle counts use the community's own active members (4), not the whole group's", async () => {
    const fun = await cmatch("c-fun");
    const v = await spotView(fun);
    expect(v.status).toBe(200);
    expect(v.body.rotation).toEqual({ communityName: "FunnyStuff" });
    expect(v.body.progress).toEqual({ cycle: 1, selected: 0, roster: 4, complete: false });
    expect((await spotView(await cmatch("c-fc"))).body.progress.roster).toBe(4);
    const wg = await spotView(await cmatch(null));
    expect(wg.body.rotation).toEqual({ communityName: null });
    expect(wg.body.progress.roster).toBe(6);
  });

  it("independent rotations: a FunnyStuff cycle never touches UCCNE - FC or the whole group; a shared player has a turn in each", async () => {
    const picked: string[] = [];
    for (let i = 0; i < FUN.length; i++) {
      const id = await cmatch("c-fun");
      await attend(id, FUN);
      const r = await spot(id, "select");
      expect(r.status).toBe(200);
      expect(r.body.pick.cycle).toBe(1);
      picked.push(r.body.pick.playerId);
    }
    expect([...picked].sort()).toEqual(FUN); // each FunnyStuff member once
    expect(await prisma.spotlightPick.count({ where: { communityId: "c-fun" } })).toBe(4);
    expect(await prisma.spotlightRotation.count()).toBe(0); // the whole-group rotation was never used

    const fc = await cmatch("c-fc");
    expect(await progress(fc)).toEqual({ cycle: 1, selected: 0, roster: 4, complete: false });
    await attend(fc, ["p3", "p4"]); // both already had their FunnyStuff turn
    const shared = await selectSpotlight("ga", fc, null, { rand: first });
    expect(shared.ok && shared.view.pick).toMatchObject({ playerId: "p3", cycle: 1 });
    expect(await prisma.spotlightPick.findFirstOrThrow({ where: { matchId: fc } })).toMatchObject({ communityId: "c-fc", cycle: 1 });

    const wg = await cmatch(null);
    expect(await progress(wg)).toEqual({ cycle: 1, selected: 0, roster: 6, complete: false });

    // The next FunnyStuff pick opens FunnyStuff's cycle 2; UCCNE - FC stays in cycle 1.
    const fun5 = await cmatch("c-fun");
    await attend(fun5, FUN);
    expect((await spot(fun5, "select")).body.pick.cycle).toBe(2);
    expect(await prisma.spotlightCommunityRotation.findMany({ orderBy: { communityId: "asc" }, select: { communityId: true, groupId: true, cycle: true } })).toEqual([
      { communityId: "c-fc", groupId: "ga", cycle: 1 },
      { communityId: "c-fun", groupId: "ga", cycle: 2 },
    ]);
  });

  it("absentees keep their turn; no repeats in a community cycle; non-members are never eligible", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await cmatch("c-fun");
      await attend(id, ["p1", "p2", "p6"]); // p6 is not a FunnyStuff member → never confirmed here
      const r = await spot(id, "select");
      expect(r.status).toBe(200);
      seen.push(r.body.pick.playerId);
    }
    expect(seen.sort()).toEqual(["p1", "p2"]);
    const third = await cmatch("c-fun");
    await attend(third, ["p1", "p2", "p6"]);
    const r = await spot(third, "select");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ALL_ATTENDEES_SELECTED");
    expect(r.body.view.progress).toEqual({ cycle: 1, selected: 2, roster: 4, complete: false }); // p3, p4 keep their turn
    expect(r.body.view.confirmedCount).toBe(2);
  });

  it("membership changes: a new member joins the right rotation; removed or deactivated members stop counting", async () => {
    const fun = await cmatch("c-fun");
    await prisma.communityPlayer.create({ data: { groupId: "ga", communityId: "c-fun", playerId: "p5" } });
    expect((await progress(fun)).roster).toBe(5);
    expect((await progress(await cmatch("c-fc"))).roster).toBe(4); // UCCNE - FC unchanged
    await prisma.communityPlayer.delete({ where: { communityId_playerId: { communityId: "c-fun", playerId: "p4" } } });
    await prisma.player.update({ where: { id: "p1" }, data: { isActive: false } });
    expect((await progress(fun)).roster).toBe(3);
    expect((await progress(await cmatch("c-fc"))).roster).toBe(4); // p4 still a UCCNE - FC member
  });

  it("a pick made before per-community rotations (whole-group scope) is kept as it is — shown, idempotent, counted only in the whole group", async () => {
    const fun = await cmatch("c-fun");
    await attend(fun, FUN);
    // What the migration leaves in place: communityId NULL = drawn in the whole-group rotation.
    await prisma.spotlightRotation.create({ data: { groupId: "ga" } });
    await prisma.spotlightPick.create({ data: { groupId: "ga", matchId: fun, cycle: 1, playerId: "p2", playerName: "Ben Two", note: "Bring cones" } });

    const v = await spotView(fun);
    expect(v.body.pick).toMatchObject({ playerId: "p2", otherRotation: true, rotationName: null });
    expect(v.body.progress).toEqual({ cycle: 1, selected: 0, roster: 4, complete: false }); // not silently moved into FunnyStuff
    expect((await progress(await cmatch(null))).selected).toBe(1); // still counts where it was drawn
    const again = await spot(fun, "select");
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false); // the existing selection is returned, never redrawn
    expect(await prisma.spotlightPick.count()).toBe(1);

    // Replacement (p2 no longer playing): the old pick is released in ITS OWN rotation, the new one is FunnyStuff's.
    await attend(fun, ["p2"], "ga", "NOT_PLAYING");
    const rep = await selectSpotlight("ga", fun, null, { replace: true, rand: first });
    expect(rep.ok).toBe(true);
    const rows = await prisma.spotlightPick.findMany({ where: { matchId: fun }, orderBy: { createdAt: "asc" }, select: { playerId: true, status: true, communityId: true, note: true } });
    expect(rows).toEqual([
      { playerId: "p2", status: "RELEASED", communityId: null, note: "Bring cones" },
      { playerId: "p1", status: "ACTIVE", communityId: "c-fun", note: "Bring cones" },
    ]);
  });

  it("the database allows the same player once per cycle PER SCOPE — and refuses a second counted pick in the same scope", async () => {
    const [a, b, c, d] = [await cmatch("c-fun"), await cmatch("c-fc"), await cmatch(null), await cmatch("c-fun")];
    const pick = (matchId: string, communityId: string | null) => prisma.spotlightPick.create({ data: { groupId: "ga", matchId, communityId, cycle: 1, playerId: "p3", playerName: "Cai Three" } });
    await pick(a, "c-fun");
    await pick(b, "c-fc");
    await pick(c, null);
    await expect(pick(d, "c-fun")).rejects.toThrow();
    // A pick can't claim a community of another group.
    await prisma.community.create({ data: { id: "c-other", groupId: "ga2", name: "Other" } });
    await expect(prisma.spotlightPick.create({ data: { groupId: "ga", matchId: d, communityId: "c-other", cycle: 1, playerId: "p4", playerName: "x" } })).rejects.toThrow();
  });

  it("concurrent requests: one selection per match; FunnyStuff and UCCNE - FC selections run side by side", async () => {
    const fun = await cmatch("c-fun");
    await attend(fun, FUN);
    const results = await Promise.all(Array.from({ length: 6 }, () => selectSpotlight("ga", fun, null)));
    expect(new Set(results.map((r) => (r.ok ? r.view.pick?.playerId : null))).size).toBe(1);
    expect(await prisma.spotlightPick.count({ where: { matchId: fun } })).toBe(1);

    const [f2, c2] = [await cmatch("c-fun"), await cmatch("c-fc")];
    await attend(f2, ["p3", "p4"]);
    await attend(c2, ["p3", "p4"]);
    const [r1, r2] = await Promise.all([selectSpotlight("ga", f2, null), selectSpotlight("ga", c2, null)]);
    expect(r1.ok && r2.ok).toBe(true); // at most one of p3/p4 had a FunnyStuff turn; UCCNE - FC is independent
    expect(await prisma.spotlightPick.findMany({ where: { matchId: { in: [f2, c2] } }, orderBy: { communityId: "asc" }, select: { communityId: true } })).toEqual([{ communityId: "c-fc" }, { communityId: "c-fun" }]);
  });
});

// ============================================================================ Feature B
describe("Random Player Spotlight", () => {
  const ROSTER = ["p1", "p2", "p3", "p4", "p5", "p6"];

  it("every active member is selected exactly once per cycle; the next cycle starts only after the last one", async () => {
    const picked: string[] = [];
    for (let i = 0; i < ROSTER.length; i++) {
      const id = await match();
      await attend(id, ROSTER);
      const r = await spot(id, "select");
      expect(r.status).toBe(200);
      expect(r.body.pick.cycle).toBe(1);
      picked.push(r.body.pick.playerId);
    }
    expect([...picked].sort()).toEqual(ROSTER); // all six, no repeats
    const id7 = await match();
    await attend(id7, ROSTER);
    const seventh = await spot(id7, "select");
    expect(seventh.body.pick.cycle).toBe(2); // reset only after everyone had a turn
    expect((await prisma.spotlightRotation.findUniqueOrThrow({ where: { groupId: "ga" } })).cycle).toBe(2);
  });

  it("random order: across fresh cycles the first pick varies over the attendees", async () => {
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await prisma.spotlightPick.deleteMany({ where: { groupId: "ga" } });
      const id = await match();
      await attend(id, ["p1", "p2", "p3"]);
      firsts.add((await selectSpotlight("ga", id, null)).ok ? (await prisma.spotlightPick.findFirstOrThrow({ where: { matchId: id } })).playerId : "none");
    }
    expect(firsts).toEqual(new Set(["p1", "p2", "p3"]));
  });

  it("absent members keep their turn; no premature reset; no eligible attendee → clear message, nothing picked", async () => {
    const first: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await match();
      await attend(id, ["p1", "p2", "p3"]); // p4–p6 absent
      first.push((await spot(id, "select")).body.pick.playerId);
    }
    expect([...first].sort()).toEqual(["p1", "p2", "p3"]);
    // Only already-picked players attend: nothing selected, cycle NOT restarted.
    const id4 = await match();
    await attend(id4, ["p1", "p2", "p3"]);
    const r = await spot(id4, "select");
    expect(r).toMatchObject({ status: 409, body: { code: "ALL_ATTENDEES_SELECTED" } });
    expect(await prisma.spotlightPick.count({ where: { matchId: id4 } })).toBe(0);
    expect((await prisma.spotlightRotation.findUniqueOrThrow({ where: { groupId: "ga" } })).cycle).toBe(1);
    // When an absent member attends, they're picked (they kept their turn).
    const id5 = await match();
    await attend(id5, ["p1", "p4"]);
    expect((await spot(id5, "select")).body.pick.playerId).toBe("p4");
  });

  it("new members join the current cycle; deactivated members don't block it from finishing", async () => {
    for (const ids of [["p1"], ["p2"], ["p3"], ["p4"], ["p5"]]) {
      const id = await match();
      await attend(id, ids);
      await spot(id, "select");
    }
    await prisma.player.update({ where: { id: "p6" }, data: { isActive: false } }); // never picked, now inactive
    await prisma.player.create({ data: { id: "p7", groupId: "ga", firstName: "New", lastName: "Member", position: "FORWARD", rating: "GOOD", stamina: 3 } });
    let v = await spotView(await match());
    expect(v.body.progress).toMatchObject({ cycle: 1, selected: 5, roster: 6, complete: false }); // p7 joined, p6 excluded
    const id = await match();
    await attend(id, ["p1", "p7"]);
    expect((await spot(id, "select")).body.pick.playerId).toBe("p7");
    v = await spotView(id);
    expect(v.body.progress).toMatchObject({ cycle: 1, selected: 6, roster: 6, complete: true });
    const next = await match();
    await attend(next, ["p1"]);
    expect((await spot(next, "select")).body.pick).toMatchObject({ playerId: "p1", cycle: 2 });
  });

  it("idempotent: repeat requests return the existing selection; Generate/Publish/reload never redraw", async () => {
    const id = await match();
    await attend(id, ROSTER);
    const a = await spot(id, "select");
    const b = await spot(id, "select");
    expect(a.body.created).toBe(true);
    expect(b.body).toMatchObject({ created: false, pick: { playerId: a.body.pick.playerId } });
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-11-20", selectedIds: ROSTER, matchId: id }), g(A))).json();
    await publishFor(id, gen.teams);
    expect((await spotView(id)).body.pick.playerId).toBe(a.body.pick.playerId);
    expect(await prisma.spotlightPick.count()).toBe(1);
  });

  it("concurrent requests: one selection per match, and two matches never consume the same slot", async () => {
    const id = await match();
    await attend(id, ROSTER);
    const results = await Promise.all(Array.from({ length: 6 }, () => selectSpotlight("ga", id, null)));
    const ids = new Set(results.map((r) => (r.ok ? r.view.pick?.playerId : null)));
    expect(ids.size).toBe(1);
    expect(await prisma.spotlightPick.count({ where: { matchId: id } })).toBe(1);
    // Two different matches at once with the same two attendees → two different players.
    const [m1, m2] = [await match(), await match()];
    await attend(m1, ["p2", "p3"]);
    await attend(m2, ["p2", "p3"]);
    await prisma.spotlightPick.deleteMany({ where: { matchId: id } });
    const [r1, r2] = await Promise.all([selectSpotlight("ga", m1, null), selectSpotlight("ga", m2, null)]);
    expect(r1.ok && r2.ok).toBe(true);
    const picks = await prisma.spotlightPick.findMany({ where: { matchId: { in: [m1, m2] } }, select: { playerId: true } });
    expect(new Set(picks.map((p) => p.playerId)).size).toBe(2);
  });

  it("attendance changes after selection: warning, controlled replacement (no reroll), the absent player keeps their turn", async () => {
    const id = await match();
    await attend(id, ["p1", "p2", "p3"]);
    const first = (await spot(id, "select")).body.pick.playerId as string;
    expect(await spot(id, "replace")).toMatchObject({ status: 409, body: { code: "STILL_ATTENDING" } }); // no unrestricted reroll
    await spotNote(id, "Bring the ball");
    await attend(id, [first], "ga", "NOT_PLAYING");
    expect((await spotView(id)).body.stillAttending).toBe(false);
    const rep = await spot(id, "replace");
    expect(rep.status).toBe(200);
    expect(rep.body.pick.playerId).not.toBe(first);
    expect(rep.body.pick.note).toBe("Bring the ball"); // the organizer's text is kept
    expect(await prisma.spotlightPick.findMany({ where: { matchId: id }, select: { playerId: true, status: true }, orderBy: { createdAt: "asc" } })).toEqual([
      { playerId: first, status: "RELEASED" },
      { playerId: rep.body.pick.playerId, status: "ACTIVE" },
    ]);
    expect(rep.body.progress.selected).toBe(1); // one slot used, not two
    const later = await match();
    await attend(later, [first]);
    expect((await spot(later, "select")).body.pick.playerId).toBe(first); // got their turn back
  });

  // Cycle-transition regression: a pick from an already-closed cycle is replaced without
  // rewriting that cycle, the replacement is drawn in the current cycle, nobody repeats in any cycle.
  describe("replacement across a cycle boundary", () => {
    const first = () => 0; // deterministic draw: the first id of the sorted pool
    const second = (max: number) => Math.min(1, max - 1);
    async function twoPlayerGroup() {
      await prisma.player.updateMany({ where: { groupId: "ga", id: { notIn: ["p1", "p2"] } }, data: { isActive: false } });
    }
    const counted = async (cycle: number) =>
      (await prisma.spotlightPick.findMany({ where: { groupId: "ga", cycle, status: { in: ["ACTIVE", "REPLACED"] } }, select: { playerId: true } })).map((p) => p.playerId).sort();
    const noRepeats = async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM (SELECT "cycle","playerId" FROM "SpotlightPick" WHERE "groupId"='ga' AND status <> 'RELEASED' GROUP BY 1,2 HAVING count(*) > 1) d`
      );
      expect(rows[0].n).toBe(0);
    };

    it("a closed cycle's history is never rewritten: old pick → REPLACED (still counted), new pick in the current cycle", async () => {
      await twoPlayerGroup();
      const [m1, m2, m3] = [await match(), await match(), await match()];
      for (const m of [m1, m2, m3]) await attend(m, ["p1", "p2"]);
      await selectSpotlight("ga", m1, null, { rand: first }); // p1, cycle 1
      await selectSpotlight("ga", m2, null, { rand: first }); // p2, cycle 1 → complete
      await selectSpotlight("ga", m3, null, { rand: first }); // cycle 2 starts: p1
      expect(await counted(1)).toEqual(["p1", "p2"]);
      expect(await counted(2)).toEqual(["p1"]);

      await attend(m1, ["p1"], "ga", "NOT_PLAYING"); // Match 1's (cycle-1) pick stops playing
      const r = await selectSpotlight("ga", m1, null, { replace: true, rand: first });
      expect(r.ok).toBe(true);
      expect(await prisma.spotlightPick.findMany({ where: { matchId: m1 }, select: { playerId: true, cycle: true, status: true }, orderBy: { createdAt: "asc" } })).toEqual([
        { playerId: "p1", cycle: 1, status: "REPLACED" }, // cycle 1 untouched
        { playerId: "p2", cycle: 2, status: "ACTIVE" }, // drawn in the current cycle
      ]);
      expect(await counted(1)).toEqual(["p1", "p2"]); // closed cycle history identical
      expect(await counted(2)).toEqual(["p1", "p2"]); // cycle 2 now complete — p2 once, p1 once
      await noRepeats();
      // The next selection correctly starts cycle 3.
      const m4 = await match();
      await attend(m4, ["p1", "p2"]);
      expect((await selectSpotlight("ga", m4, null, { rand: first })).ok).toBe(true);
      expect((await prisma.spotlightPick.findFirstOrThrow({ where: { matchId: m4, status: "ACTIVE" } })).cycle).toBe(3);
      await noRepeats();
    });

    it("all-or-nothing: if nobody can be drawn, the original pick stays and no cycle changes", async () => {
      await twoPlayerGroup();
      const [m1, m2, m3] = [await match(), await match(), await match()];
      for (const m of [m1, m2, m3]) await attend(m, ["p1", "p2"]);
      await selectSpotlight("ga", m1, null, { rand: first }); // p1 c1
      await selectSpotlight("ga", m2, null, { rand: first }); // p2 c1
      await selectSpotlight("ga", m3, null, { rand: second }); // c2: p2
      await attend(m1, ["p1"], "ga", "NOT_PLAYING"); // only p2 confirmed, and p2 already had cycle 2's turn
      const before = await prisma.spotlightPick.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, status: true, cycle: true, playerId: true } });
      const r = await spot(m1, "replace");
      expect(r).toMatchObject({ status: 409, body: { code: "ALL_ATTENDEES_SELECTED" } });
      expect(await prisma.spotlightPick.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, status: true, cycle: true, playerId: true } })).toEqual(before); // rolled back
      expect((await spotView(m1)).body).toMatchObject({ pick: { playerId: "p1" }, stillAttending: false }); // warning stays; nothing lost
      expect((await prisma.spotlightRotation.findUniqueOrThrow({ where: { groupId: "ga" } })).cycle).toBe(2);
    });

    it("the database refuses a second counted pick of the same player in a cycle, REPLACED included", async () => {
      await twoPlayerGroup();
      const m1 = await match();
      await attend(m1, ["p1"]);
      await selectSpotlight("ga", m1, null);
      await prisma.spotlightPick.updateMany({ where: { matchId: m1 }, data: { status: "REPLACED" } });
      const m2 = await match();
      await expect(prisma.spotlightPick.create({ data: { groupId: "ga", matchId: m2, cycle: 1, playerId: "p1", playerName: "Ana One" } })).rejects.toThrow(/Unique constraint/);
      await prisma.spotlightPick.updateMany({ where: { matchId: m1 }, data: { status: "RELEASED" } }); // a RELEASED turn frees the slot
      await expect(prisma.spotlightPick.create({ data: { groupId: "ga", matchId: m2, cycle: 1, playerId: "p1", playerName: "Ana One" } })).resolves.toBeTruthy();
    });
  });

  it("organizer text: saved, Unicode kept, length-limited, plain text only", async () => {
    const id = await match();
    await attend(id, ["p1"]);
    expect((await spotNote(id, "x")).status).toBe(409); // nothing selected yet
    await spot(id, "select");
    expect((await spotNote(id, "  Bring the match ball! ⚽  ")).body.pick.note).toBe("Bring the match ball! ⚽");
    expect((await spotNote(id, "x".repeat(201))).status).toBe(400);
    expect((await spotNote(id, { html: "<b>" })).status).toBe(400);
    expect((await spotNote(id, "")).body.pick.note).toBeNull();
  });

  it("Telegram: the saved pick + escaped text at the bottom; retries never redraw; a text edit offers 'post updated' with the same player", async () => {
    const id = await match();
    await attend(id, ["p1", "p2", "p3", "p4"]);
    expect((await publishFor(id, [{ teamNumber: 1, shirtColor: "yellow", players: [{ id: "p1" }, { id: "p2" }] }, { teamNumber: 2, shirtColor: "blue", players: [{ id: "p3" }, { id: "p4" }] }])).status).toBe(200);
    const sel = await spot(id, "select");
    const name = sel.body.pick.playerName as string;
    await spotNote(id, "<b>Bring</b> the ball & cones ⚽");
    const chatRef = (await prisma.telegramChat.findFirstOrThrow({ where: { groupId: "ga" } })).id;
    expect((await call(pollRoute.POST(json("POST", { chatRef }), gm(A, id)))).status).toBe(201);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    const genId = (await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } })).id;
    const post = (intent?: string) => call(closePostRoute.POST(json("POST", { pollId, teamGenerationId: genId, ...(intent ? { intent } : {}) }), g(A)));
    const status = async () => (await (await deliveryRoute.GET(new Request(`http://itest.local/?pollId=${pollId}&teamGenerationId=${genId}`), g(A))).json()).state;

    expect((await post()).status).toBe(200);
    const text = sentTexts().at(-1)!;
    expect(text).toContain("<b>\u{1F7E1} Team #1 — YELLOW SHIRTS</b>"); // existing content intact
    expect(text.endsWith(`\n\n<b>\u{1F3B2} Random Player Spotlight</b>\nSelected: ${name}\n&lt;b&gt;Bring&lt;/b&gt; the ball &amp; cones ⚽`)).toBe(true);
    const sendsAfter = sentTexts().length;
    expect((await post()).body.status).toBe("already_posted"); // retry: nothing sent, nobody redrawn
    expect(sentTexts().length).toBe(sendsAfter);

    await spotNote(id, "Bring the pump too");
    expect(await status()).toBe("updated_available");
    expect((await post("post_updated")).status).toBe(200);
    expect(sentTexts().at(-1)!.endsWith(`Selected: ${name}\nBring the pump too`)).toBe(true);
    expect(await prisma.spotlightPick.count()).toBe(1); // never another draw
    expect(otherNetwork).toBe(0);
  });

  it("isolation: MEMBER and other organizations get 404; each group keeps its own rotation", async () => {
    const id = await match();
    await attend(id, ["p1"]);
    await signInAs("member@example.test");
    expect((await spotView(id)).status).toBe(404);
    expect((await spot(id, "select")).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await spot(id, "select")).status).toBe(404);
    expect((await spot(id, "select", B)).status).toBe(404);
    expect(await prisma.spotlightPick.count()).toBe(0);
    await signInAs("owner@example.test");
    await spot(id, "select");
    const a2 = await match("ga2");
    await attend(a2, ["a2p1", "a2p2"], "ga2");
    const r = await spot(a2, "select", A2);
    expect(r.body.progress).toMatchObject({ cycle: 1, selected: 1, roster: 2 }); // its own cycle, untouched by group A
    expect(["a2p1", "a2p2"]).toContain(r.body.pick.playerId);
  });
});

// ============================================================================ consistency
describe("Attendance consistency: Generate, Reuse and Spotlight use ONE confirmed-attendance rule", () => {
  it("PLAYING counts; MAYBE / NOT_PLAYING / overridden-out / inactive never do; an override-in does", async () => {
    const id = await match();
    await attend(id, ["p1"]); // PLAYING
    await attend(id, ["p2"], "ga", "MAYBE");
    await attend(id, ["p3"], "ga", "NOT_PLAYING");
    await attend(id, ["p4"]); // answered PLAYING …
    await prisma.attendanceResponse.update({ where: { matchId_playerId: { matchId: id, playerId: "p4" } }, data: { overrideStatus: "NOT_PLAYING", overrideAt: new Date() } }); // … organizer: out
    await attend(id, ["p5"], "ga", "NOT_PLAYING"); // answered NOT_PLAYING …
    await prisma.attendanceResponse.update({ where: { matchId_playerId: { matchId: id, playerId: "p5" } }, data: { overrideStatus: "PLAYING", overrideAt: new Date() } }); // … organizer: in
    await attend(id, ["p6"]);
    await prisma.player.update({ where: { id: "p6" }, data: { isActive: false } }); // inactive

    const confirmed = (await confirmedAttendeeIds("ga", id))!.sort();
    expect(confirmed).toEqual(["p1", "p5"]);
    // 1. Normal generation's default selection (the Match workspace) is the same set.
    const v = await (await matchRoute.GET(json("GET"), gm(A, id))).json();
    expect([...v.defaultSelection].sort()).toEqual(confirmed);

    // 2. Reuse: from a publication containing everyone, only the confirmed are returning.
    const prev = await match("ga", "2026-11-13");
    await publishFor(prev, [{ teamNumber: 1, players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }, { teamNumber: 2, players: [{ id: "p4" }, { id: "p5" }, { id: "p6" }] }], "2026-11-13");
    const gen = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: prev } });
    const plan = await reusePlan(id, gen.id);
    expect(plan.body.teams.flatMap((t: { players: Array<{ id: string }> }) => t.players.map((p) => p.id)).sort()).toEqual(confirmed);
    expect(plan.body.unassigned).toEqual([]);
    expect(plan.body.absent.map((p: { id: string }) => p.id).sort()).toEqual(["p2", "p3", "p4", "p6"]);

    // 3. Spotlight: over many fresh draws, only confirmed attendees are ever selected.
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      await prisma.spotlightPick.deleteMany({ where: { groupId: "ga" } });
      const r = await selectSpotlight("ga", id, null);
      expect(r.ok).toBe(true);
      seen.add((await prisma.spotlightPick.findFirstOrThrow({ where: { matchId: id, status: "ACTIVE" } })).playerId);
    }
    expect([...seen].every((p) => confirmed.includes(p))).toBe(true);
    expect(seen.size).toBe(2);
  });
});
