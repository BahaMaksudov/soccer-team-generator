/**
 * M7 — REAL-DATABASE tests for the Multi-Sport Foundation: role keys as
 * TEXT (migration #17), sport-scoped role validation, the sport-neutral
 * engine through the real Generate/Publish routes, generation metadata,
 * Add Group, sport immutability, settings and public privacy.
 *
 * Guarded local TEST database only. Real routes/services/Prisma; only the
 * NextAuth session lookup is mocked. Any network call is counted and
 * forbidden (nothing here talks to Telegram, WhatsApp, Resend or AI).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { ENGINE_VERSION } from "@/lib/balanceEngine";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";
import * as groupsRoute from "@/app/api/admin/o/[organizationSlug]/groups/route";
import * as organizationsRoute from "@/app/api/admin/organizations/route";
import * as publicPlayersRoute from "@/app/api/public/[organizationSlug]/[groupSlug]/players/route";
import { loadPublicGroupHomeData } from "@/app/g/[organizationSlug]/[groupSlug]/data";
import { loadPublicGroupPrintData } from "@/app/g/[organizationSlug]/[groupSlug]/print/[generationId]/data";

const ORG = "org-a";
const G = (groupSlug: string) => ({ organizationSlug: ORG, groupSlug });
const g = (x: { organizationSlug: string; groupSlug: string }) => ({ params: Promise.resolve(x) });
const gp = (x: { organizationSlug: string; groupSlug: string }, id: string) => ({ params: Promise.resolve({ ...x, id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

let networkCalls = 0;
const originalFetch = global.fetch;

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
  return u;
}

const SPORT_GROUPS = [
  ["gs", "soccer", "soccer"],
  ["gbb", "basketball", "basketball"],
  ["gvb", "volleyball", "volleyball"],
  ["gff", "flag-football", "flag_football"],
  ["got", "other", "other"],
] as const;

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","MessageDelivery","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  const mk = (email: string) =>
    prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: verified } });
  const [owner, admin, member, ownerB] = await Promise.all([mk("owner@example.test"), mk("admin@example.test"), mk("member@example.test"), mk("owner-b@example.test")]);
  await prisma.organization.create({ data: { id: "org-a-id", name: "Org A", slug: "org-a" } });
  await prisma.organization.create({ data: { id: "org-b-id", name: "Org B", slug: "org-b" } });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: owner.id, organizationId: "org-a-id", role: "OWNER" },
      { userId: admin.id, organizationId: "org-a-id", role: "ADMIN" },
      { userId: member.id, organizationId: "org-a-id", role: "MEMBER" },
      { userId: ownerB.id, organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  for (const [id, slug, sportKey] of SPORT_GROUPS) {
    await prisma.group.create({ data: { id, organizationId: "org-a-id", name: slug, slug, sportKey, timezone: "UTC", visibility: "PUBLIC" } });
  }
  await prisma.group.create({ data: { id: "gb-soccer", organizationId: "org-b-id", name: "B Soccer", slug: "b-soccer", sportKey: "soccer", timezone: "UTC", visibility: "PUBLIC" } });
}

/** Insert players directly (rating/stamina varied) and return their ids. */
async function addPlayers(groupId: string, roles: string[]) {
  const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
  const rows = roles.map((position, i) => ({ id: `${groupId}-${i}`, groupId, firstName: `F${i}`, lastName: `${groupId}${i}`, position, rating: ratings[i % 4], stamina: 1 + (i % 5) }));
  await prisma.player.createMany({ data: rows });
  return rows.map((r) => r.id);
}

async function generate(slug: string, selectedIds: string[], teamCount: number) {
  const res = await generateRoute.POST(json("POST", { teamCount, date: "2026-10-12", selectedIds }), g(G(slug)));
  return { status: res.status, data: await res.json() };
}
const roleCounts = (teams: Array<{ players: Array<{ position: string }> }>, role: string) => teams.map((t) => t.players.filter((p) => p.position === role).length);

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
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
});

// =================================================================== schema
describe("migration #17 schema", () => {
  it("Player.position is TEXT, the Position enum is gone, TeamGeneration has nullable metadata", async () => {
    const [col] = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(`SELECT data_type FROM information_schema.columns WHERE table_name='Player' AND column_name='position'`);
    expect(col.data_type).toBe("text");
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int n FROM pg_type WHERE typname='Position'`);
    expect(n).toBe(0);
    const meta = await prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='TeamGeneration' AND column_name IN ('sportKey','engineVersion','metricsJson') ORDER BY column_name`
    );
    expect(meta).toEqual([
      { column_name: "engineVersion", is_nullable: "YES" },
      { column_name: "metricsJson", is_nullable: "YES" },
      { column_name: "sportKey", is_nullable: "YES" },
    ]);
  });

  it("legacy soccer role values and legacy generations are stored and read back unchanged", async () => {
    await addPlayers("gs", ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"]);
    expect((await prisma.player.findMany({ where: { groupId: "gs" }, orderBy: { id: "asc" } })).map((p) => p.position)).toEqual(["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"]);
    const legacy = await prisma.teamGeneration.create({
      data: { groupId: "gs", date: new Date("2026-01-05T00:00:00Z"), teamsJson: '[{"teamNumber":1,"players":[{"id":"gs-0","firstName":"F0","lastName":"L","position":"GOALKEEPER","rating":"GOOD","telegramUserId":"900003"}]}]' },
    });
    expect(legacy).toMatchObject({ sportKey: null, engineVersion: null, metricsJson: null });
    // Public reads of a legacy snapshot stay on the allow-list (no Telegram fields, no rating).
    const print = await loadPublicGroupPrintData({ ...G("soccer"), generationId: legacy.id });
    expect(print?.teams).toEqual([{ teamNumber: 1, players: [{ firstName: "F0", lastName: "L", position: "GOALKEEPER" }] }]);
    expect(stringify(print)).not.toMatch(/telegram|900003|rating|GOOD/i);
  });
});

// =================================================================== role validation
describe("sport-scoped role validation (server-authoritative)", () => {
  const create = (slug: string, position: string) =>
    playersRoute.POST(json("POST", { firstName: "A", lastName: "B", position, rating: "GOOD" }), g(G(slug)));

  it("each sport accepts its own roles and rejects other sports' roles", async () => {
    await signInAs("owner@example.test");
    const cases: Array<[string, string, number]> = [
      ["soccer", "GOALKEEPER", 200], ["soccer", "ANY", 200], ["soccer", "SETTER", 400],
      ["basketball", "BIG", 200], ["basketball", "GOALKEEPER", 400], ["basketball", "ANY", 200],
      ["volleyball", "SETTER", 200], ["volleyball", "ALL_AROUND", 200], ["volleyball", "GOALKEEPER", 400],
      ["flag-football", "QUARTERBACK", 200], ["flag-football", "ATHLETE", 200], ["flag-football", "BIG", 400],
      ["other", "PLAYER", 200], ["other", "ANY", 400], ["other", "goalkeeper", 400], ["other", "x".repeat(60), 400],
    ];
    for (const [slug, role, status] of cases) expect([slug, role, (await create(slug, role)).status]).toEqual([slug, role, status]);
  });

  it("PATCH validates against the Player's own Group; cross-Group ids are 404", async () => {
    await signInAs("owner@example.test");
    const [bb] = await addPlayers("gbb", ["BIG"]);
    expect((await playerRoute.PATCH(json("PATCH", { position: "GOALKEEPER" }), gp(G("basketball"), bb))).status).toBe(400);
    expect((await playerRoute.PATCH(json("PATCH", { position: "GUARD" }), gp(G("basketball"), bb))).status).toBe(200);
    // A soccer URL cannot be used to give the basketball Player a soccer role.
    expect((await playerRoute.PATCH(json("PATCH", { position: "GOALKEEPER" }), gp(G("soccer"), bb))).status).toBe(404);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: bb } })).position).toBe("GUARD");
  });

  it("a forged sportKey/groupId in the body changes nothing", async () => {
    await signInAs("owner@example.test");
    const res = await playersRoute.POST(json("POST", { firstName: "A", lastName: "B", position: "GOALKEEPER", rating: "GOOD", sportKey: "soccer", groupId: "gs" }), g(G("basketball")));
    expect(res.status).toBe(400);
    expect(await prisma.player.count()).toBe(0);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "gbb" } })).sportKey).toBe("basketball");
  });
});

// =================================================================== generation per sport
describe("generation through the real routes", () => {
  beforeEach(async () => {
    await signInAs("owner@example.test");
  });

  it("soccer: one GK per team when supplied; shortage warns; never fails", async () => {
    const ids = await addPlayers("gs", ["GOALKEEPER", "GOALKEEPER", "GOALKEEPER", ...Array(12).fill("MIDFIELDER")]);
    const ok = await generate("soccer", ids, 3);
    expect(ok.status).toBe(200);
    expect(roleCounts(ok.data.teams, "GOALKEEPER")).toEqual([1, 1, 1]);
    expect(ok.data).toMatchObject({ warnings: [], engineVersion: ENGINE_VERSION, sportKey: "soccer" });
    const short = await generate("soccer", ids.slice(1), 3); // 2 GKs / 3 teams
    expect(short.status).toBe(200);
    expect(short.data.warnings).toEqual([expect.objectContaining({ code: "ROLE_SHORTAGE", roleKey: "GOALKEEPER", available: 2, needed: 3 })]);
    const none = await generate("soccer", ids.slice(3), 2);
    expect(none.data.warnings[0]).toMatchObject({ roleKey: "GOALKEEPER", available: 0 });
  });

  it("basketball: 2 and 3 teams, Bigs spread, no goalkeeper anywhere", async () => {
    const ids = await addPlayers("gbb", ["BIG", "BIG", "BIG", ...Array.from({ length: 12 }, (_, i) => ["GUARD", "WING", "ANY"][i % 3])]);
    for (const tc of [2, 3]) {
      const r = await generate("basketball", ids, tc);
      expect(r.status).toBe(200);
      expect(r.data.teams).toHaveLength(tc);
      expect(Math.min(...roleCounts(r.data.teams, "BIG"))).toBeGreaterThanOrEqual(1);
      expect(stringify(r.data.warnings)).not.toMatch(/GOALKEEPER/);
      expect(r.data.warnings).toEqual([]);
    }
  });

  it("volleyball: setters spread; 1 setter / 2 teams warns", async () => {
    const two = await addPlayers("gvb", ["SETTER", "SETTER", ...Array(10).fill("ALL_AROUND")]);
    const r = await generate("volleyball", two, 2);
    expect(roleCounts(r.data.teams, "SETTER")).toEqual([1, 1]);
    const short = await generate("volleyball", two.slice(1), 2);
    expect(short.data.warnings).toEqual([expect.objectContaining({ code: "ROLE_SHORTAGE", roleKey: "SETTER", available: 1, needed: 2 })]);
    expect(stringify(short.data)).not.toMatch(/GOALKEEPER/);
  });

  it("American Football (flag_football): QBs spread; 1 QB / 3 teams warns; ATHLETE works", async () => {
    const ids = await addPlayers("gff", ["QUARTERBACK", ...Array.from({ length: 11 }, (_, i) => (i % 2 ? "ATHLETE" : "RECEIVER"))]);
    const r = await generate("flag-football", ids, 3);
    expect(r.status).toBe(200);
    expect(r.data.warnings).toEqual([expect.objectContaining({ code: "ROLE_SHORTAGE", roleKey: "QUARTERBACK", available: 1, needed: 3 })]);
  });

  it("other: rating/stamina only, no role warnings", async () => {
    const ids = await addPlayers("got", Array(9).fill("PLAYER"));
    const r = await generate("other", ids, 3);
    expect(r.status).toBe(200);
    expect(r.data.warnings).toEqual([]);
    expect(r.data.metrics.ruleCoverage).toEqual([]);
  });

  it("the deprecated `format` is still accepted and ignored", async () => {
    const ids = await addPlayers("gs", Array(7).fill("FORWARD"));
    const res = await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids, format: 6 }), g(G("soccer")));
    expect(res.status).toBe(200);
    expect((await res.json()).teams.map((t: { players: unknown[] }) => t.players.length).sort()).toEqual([3, 4]);
  });

  it("Group A's settings/sport never affect Group B (role weights are per Group)", async () => {
    const soccerIds = await addPlayers("gs", ["DEFENDER", "DEFENDER", "FORWARD", "FORWARD"]);
    expect((await weightsRoute.PUT(json("PUT", { weights: { staminaCoef: 3, positionWeights: { DEFENDER: 50 } } }), g(G("soccer")))).status).toBe(200);
    const bb = await (await weightsRoute.GET(json("GET"), g(G("basketball")))).json();
    expect(bb.weights).toEqual({ staminaCoef: 1, positionWeights: { GUARD: 2, WING: 2, BIG: 2, ANY: 2 } });
    const vb = await (await weightsRoute.GET(json("GET"), g(G("volleyball")))).json();
    expect(vb.weights.staminaCoef).toBe(0.5);
    expect((await generate("soccer", soccerIds, 2)).status).toBe(200);
  });
});

// =================================================================== settings
describe("sport-aware settings", () => {
  it("only the Group's own role keys may be weighted; cross-tenant settings are 404", async () => {
    await signInAs("owner@example.test");
    expect((await weightsRoute.PUT(json("PUT", { weights: { positionWeights: { GOALKEEPER: 5 } } }), g(G("basketball")))).status).toBe(400);
    expect((await weightsRoute.PUT(json("PUT", { weights: { positionWeights: { BIG: 999 } } }), g(G("basketball")))).status).toBe(400); // bounded
    expect((await weightsRoute.PUT(json("PUT", { weights: { positionWeights: { BIG: 4 } } }), g(G("basketball")))).status).toBe(200);
    expect(await prisma.groupSetting.findMany({ where: { key: "balanceWeights" }, select: { groupId: true, value: true } })).toEqual([
      { groupId: "gbb", value: JSON.stringify({ staminaCoef: 1, positionWeights: { GUARD: 2, WING: 2, BIG: 4, ANY: 2 } }) },
    ]);
    await signInAs("owner-b@example.test");
    expect((await weightsRoute.PUT(json("PUT", { weights: { staminaCoef: 2 } }), g(G("basketball")))).status).toBe(404);
    expect((await weightsRoute.GET(json("GET"), g(G("basketball")))).status).toBe(404);
  });

  it("soccer defaults are unchanged (+ ANY)", async () => {
    await signInAs("owner@example.test");
    expect((await (await weightsRoute.GET(json("GET"), g(G("soccer")))).json()).weights).toEqual({
      staminaCoef: 1,
      positionWeights: { GOALKEEPER: 2, DEFENDER: 1, MIDFIELDER: 2, FORWARD: 2, ANY: 2 },
    });
  });
});

// =================================================================== publish metadata + privacy
describe("publish metadata and public privacy", () => {
  it("records sportKey/engineVersion/metrics (aggregates only); snapshot stays allow-listed; public views hide skill", async () => {
    await signInAs("owner@example.test");
    await prisma.player.createMany({
      data: [
        { id: "v1", groupId: "gvb", firstName: "Ann", lastName: "Setter", position: "SETTER", rating: "EXCELLENT", stamina: 4, telegramUserId: 900001n },
        { id: "v2", groupId: "gvb", firstName: "Bo", lastName: "Hitter", position: "HITTER", rating: "FAIR", stamina: 2 },
      ],
    });
    const gen = await generate("volleyball", ["v1", "v2"], 2);
    const forged = gen.data.teams.map((t: { teamNumber: number; players: Array<Record<string, unknown>> }) => ({
      ...t,
      players: t.players.map((p) => ({ ...p, telegramUserId: "1", email: "x@example.com", phone: "+15550100", whatsapp: "w", userId: "u", rating: "FAIR" })),
    }));
    const res = await publishRoute.POST(json("POST", { date: gen.data.date, teams: forged }), g(G("volleyball")));
    expect(res.status).toBe(200);
    const row = await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "gvb" } });
    expect(row).toMatchObject({ sportKey: "volleyball", engineVersion: ENGINE_VERSION });
    const metrics = JSON.parse(row.metricsJson!);
    expect(metrics).toMatchObject({ teamCount: 2, playerCount: 2, ruleCoverage: [expect.objectContaining({ roleKey: "SETTER", teamsCovered: 1 })] });
    expect(row.metricsJson).not.toMatch(/Ann|Bo|v1|v2|telegram|email|phone|whatsapp|userId|firstName|lastName/i);
    // Snapshot: exactly the six allow-listed fields, DB values (forged rating ignored), no identity data.
    const snap = JSON.parse(row.teamsJson);
    for (const p of snap.flatMap((t: { players: unknown[] }) => t.players)) {
      expect(Object.keys(p as object).sort()).toEqual(["firstName", "id", "lastName", "position", "rating", "stamina"]);
    }
    expect(row.teamsJson).not.toMatch(/telegram|email|phone|whatsapp|userId|900001/i);
    // Public pages: role key only, no skill/stamina/ids.
    session = null;
    const home = await loadPublicGroupHomeData(G("volleyball"));
    expect(stringify(home?.items)).not.toMatch(/EXCELLENT|FAIR|rating|stamina|v1|telegram|metrics/i);
    const pub = await (await publicPlayersRoute.GET(json("GET"), g(G("volleyball")))).json();
    expect(stringify(pub)).not.toMatch(/rating|stamina|EXCELLENT|telegram|userId/i);
  });

  it("legacy generations stay untouched by new publishes of other dates", async () => {
    await signInAs("owner@example.test");
    const legacy = await prisma.teamGeneration.create({ data: { groupId: "gs", date: new Date("2026-01-05T00:00:00Z"), teamsJson: "[]" } });
    const ids = await addPlayers("gs", ["GOALKEEPER", "DEFENDER"]);
    const gen = await generate("soccer", ids, 2);
    await publishRoute.POST(json("POST", { date: gen.data.date, teams: gen.data.teams }), g(G("soccer")));
    expect(await prisma.teamGeneration.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
  });
});

// =================================================================== Add Group + immutability
describe("Add Group", () => {
  const add = (orgSlug: string, body: unknown) => groupsRoute.POST(json("POST", body), { params: Promise.resolve({ organizationSlug: orgSlug }) });

  it("OWNER and ADMIN create Groups of any registry sport (+ teamName setting); replay is idempotent", async () => {
    await signInAs("owner@example.test");
    const res = await add(ORG, { groupName: "Tuesday Basketball", sportKey: "basketball", timezone: "America/New_York" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, href: "/admin/o/org-a/g/tuesday-basketball", group: { slug: "tuesday-basketball", sportKey: "basketball" } });
    const created = await prisma.group.findFirstOrThrow({ where: { slug: "tuesday-basketball" }, include: { settings: true } });
    expect(created).toMatchObject({ organizationId: "org-a-id", sportKey: "basketball", timezone: "America/New_York", visibility: "LINK" });
    expect(created.settings.map((s) => [s.key, s.value])).toEqual([["teamName", "Org A"]]);
    expect((await add(ORG, { groupName: "Tuesday Basketball", sportKey: "basketball", timezone: "America/New_York" })).status).toBe(200); // replay
    await signInAs("admin@example.test");
    expect((await add(ORG, { groupName: "Tuesday Basketball", sportKey: "volleyball", timezone: "UTC" })).status).toBe(201);
    expect((await prisma.group.findMany({ where: { name: "Tuesday Basketball" }, orderBy: { slug: "asc" } })).map((g) => [g.slug, g.sportKey])).toEqual([
      ["tuesday-basketball", "basketball"],
      ["tuesday-basketball-2", "volleyball"],
    ]);
    // The new Group immediately uses its sport's roles.
    await signInAs("owner@example.test");
    const slug = { organizationSlug: ORG, groupSlug: "tuesday-basketball" };
    expect((await playersRoute.POST(json("POST", { firstName: "A", lastName: "B", position: "BIG", rating: "GOOD" }), g(slug))).status).toBe(200);
    expect((await playersRoute.POST(json("POST", { firstName: "A", lastName: "B", position: "GOALKEEPER", rating: "GOOD" }), g(slug))).status).toBe(400);
  });

  it("MEMBER, another Organization's OWNER and anonymous are refused; nothing is created", async () => {
    const before = await prisma.group.count();
    await signInAs("member@example.test");
    expect((await add(ORG, { groupName: "X", sportKey: "soccer", timezone: "UTC" })).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await add(ORG, { groupName: "X", sportKey: "soccer", timezone: "UTC" })).status).toBe(404);
    session = null;
    expect((await add(ORG, { groupName: "X", sportKey: "soccer", timezone: "UTC" })).status).toBe(401);
    expect(await prisma.group.count()).toBe(before);
  });

  it("forged sport keys and tenant ids are rejected or ignored", async () => {
    await signInAs("owner@example.test");
    for (const sportKey of ["american_football", "hockey", "SOCCER", ""]) {
      expect((await add(ORG, { groupName: "X", sportKey, timezone: "UTC" })).status).toBe(400);
    }
    const res = await add(ORG, { groupName: "Y", sportKey: "other", timezone: "UTC", organizationId: "org-b-id", slug: "evil", id: "evil" });
    expect(res.status).toBe(201);
    expect(await prisma.group.findFirstOrThrow({ where: { name: "Y" } })).toMatchObject({ organizationId: "org-a-id", slug: "y" });
  });

  it("onboarding accepts every registry sport and rejects others", async () => {
    await signInAs("owner-b@example.test");
    const post = (sportKey: string) => organizationsRoute.POST(json("POST", { organizationName: `Org ${sportKey || "none"}`, groupName: "G", sportKey, timezone: "UTC" }));
    expect((await post("flag_football")).status).toBe(201);
    expect((await post("tackle")).status).toBe(400);
  });

  it("there is no way to change a Group's sport (no route accepts it after creation)", async () => {
    await signInAs("owner@example.test");
    // Settings/players endpoints ignore a sportKey in the body.
    await weightsRoute.PUT(json("PUT", { weights: { staminaCoef: 1 }, sportKey: "soccer" }), g(G("basketball")));
    await playersRoute.POST(json("POST", { firstName: "A", lastName: "B", position: "BIG", rating: "GOOD", sportKey: "soccer" }), g(G("basketball")));
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "gbb" } })).sportKey).toBe("basketball");
  });
});

describe("network safety", () => {
  it("no network call happened", () => {
    expect(networkCalls).toBe(0);
  });
});
