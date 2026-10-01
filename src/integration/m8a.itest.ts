/**
 * M8-A — REAL-DATABASE tests for deterministic Balance Intelligence:
 * analysis in the Generate response, the Apply Swap preview endpoint (trust
 * boundary, authorization, tenant isolation, no side effects), metrics-v2 +
 * analysis persisted on Publish, and tolerance of legacy/M7 metrics.
 *
 * Guarded local TEST database only. Only the NextAuth session lookup is
 * mocked. Every network call is counted and forbidden.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { ANALYSIS_VERSION, METRICS_VERSION, parseStoredMetrics } from "@/lib/balanceAnalysis";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as swapRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/swap/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";

const G = (groupSlug: string, organizationSlug = "org-a") => ({ organizationSlug, groupSlug });
const g = (x: { organizationSlug: string; groupSlug: string }) => ({ params: Promise.resolve(x) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

let networkCalls = 0;
const originalFetch = global.fetch;

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
}

const GROUPS = [
  ["gs", "soccer", "soccer"],
  ["gbb", "basketball", "basketball"],
  ["gvb", "volleyball", "volleyball"],
  ["gaf", "american-football", "flag_football"],
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
  await prisma.organization.createMany({ data: [{ id: "org-a-id", name: "Org A", slug: "org-a" }, { id: "org-b-id", name: "Org B", slug: "org-b" }] });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: owner.id, organizationId: "org-a-id", role: "OWNER" },
      { userId: admin.id, organizationId: "org-a-id", role: "ADMIN" },
      { userId: member.id, organizationId: "org-a-id", role: "MEMBER" },
      { userId: ownerB.id, organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  for (const [id, slug, sportKey] of GROUPS) {
    await prisma.group.create({ data: { id, organizationId: "org-a-id", name: slug, slug, sportKey, timezone: "UTC", visibility: "PUBLIC" } });
  }
  await prisma.group.create({ data: { id: "gb-other", organizationId: "org-b-id", name: "B Other", slug: "b-other", sportKey: "other", timezone: "UTC" } });
  // Other group: impact = 10×skill + 2×stamina + 6 → EXC 52, VG 42, GOOD 32, FAIR 22 (stamina 3).
  await prisma.player.createMany({
    data: [
      { id: "exc", groupId: "got", firstName: "Ann", lastName: "E", position: "PLAYER", rating: "EXCELLENT", stamina: 3, telegramUserId: 900001n },
      { id: "vg", groupId: "got", firstName: "Bo", lastName: "V", position: "PLAYER", rating: "VERY_GOOD", stamina: 3 },
      { id: "good", groupId: "got", firstName: "Cy", lastName: "G", position: "PLAYER", rating: "GOOD", stamina: 3 },
      { id: "fair", groupId: "got", firstName: "Di", lastName: "F", position: "PLAYER", rating: "FAIR", stamina: 3 },
      { id: "foreign", groupId: "gb-other", firstName: "Zed", lastName: "B", position: "PLAYER", rating: "EXCELLENT", stamina: 3 },
    ],
  });
}

const UNEVEN = { teams: [{ teamNumber: 1, playerIds: ["exc", "vg"] }, { teamNumber: 2, playerIds: ["good", "fair"] }], swap: { playerA: "exc", playerB: "good" } };
const swap = (body: unknown, grp = G("other")) => swapRoute.POST(json("POST", body), g(grp));

async function addPlayers(groupId: string, roles: string[]) {
  const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
  const rows = roles.map((position, i) => ({ id: `${groupId}-${i}`, groupId, firstName: `F${i}`, lastName: `L${i}`, position, rating: ratings[i % 4], stamina: 1 + (i % 5) }));
  await prisma.player.createMany({ data: rows });
  return rows.map((r) => r.id);
}

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

describe("Generate returns deterministic analysis", () => {
  it("every sport: analysis uses the Group's sport and role rules; teams are not altered by analysis", async () => {
    await signInAs("owner@example.test");
    const roles: Record<string, string[]> = {
      soccer: ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD", "ANY", "DEFENDER"],
      basketball: ["BIG", "GUARD", "WING", "ANY", "GUARD", "WING"],
      volleyball: ["SETTER", "HITTER", "MIDDLE", "LIBERO", "ALL_AROUND", "HITTER"],
      flag_football: ["QUARTERBACK", "RECEIVER", "RUSHER_LINE", "DEFENDER", "ATHLETE", "RECEIVER"],
      other: [],
    };
    const ruleRole: Record<string, string | null> = { soccer: "GOALKEEPER", basketball: "BIG", volleyball: "SETTER", flag_football: "QUARTERBACK", other: null };
    for (const [id, slug, sportKey] of GROUPS) {
      const ids = sportKey === "other" ? ["exc", "vg", "good", "fair"] : await addPlayers(id, roles[sportKey]);
      const res = await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(G(slug)));
      expect(res.status, slug).toBe(200);
      const data = await res.json();
      expect(data.analysis).toMatchObject({ analysisVersion: ANALYSIS_VERSION, teamSizes: [ids.length / 2, ids.length / 2] });
      expect(["EVEN", "CLOSE", "UNEVEN"]).toContain(data.analysis.quality);
      expect(data.metrics.metricsVersion).toBe(METRICS_VERSION);
      expect(data.analysis.impactSpread).toBe(data.metrics.impactSpread);
      expect(data.analysis.roleCoverage.map((c: { roleKey: string }) => c.roleKey)).toEqual(ruleRole[sportKey] ? [ruleRole[sportKey]] : []);
      expect(data.analysis.rosterNotes.filter((n: { code: string }) => n.code === "ROLE_SHORTAGE").map((n: { roleKey: string }) => n.roleKey)).toEqual(
        ruleRole[sportKey] ? [ruleRole[sportKey]] : []
      ); // one special-role player for two teams
      expect(JSON.stringify(data.analysis.summary)).not.toMatch(sportKey === "soccer" ? /setter|quarterback/i : /goal ?keeper/i);
      expect(await prisma.teamGeneration.count()).toBe(0); // Generate never persists
    }
  });

  it("analysis uses the Group's authoritative balance settings", async () => {
    await signInAs("owner@example.test");
    const ids = await addPlayers("gbb", ["BIG", "GUARD", "WING", "ANY"]);
    const before = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(G("basketball")))).json();
    expect((await weightsRoute.PUT(json("PUT", { weights: { staminaCoef: 0, positionWeights: { BIG: 20 } } }), g(G("basketball")))).status).toBe(200);
    const after = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(G("basketball")))).json();
    const total = (d: { metrics: { teams: Array<{ impactTotal: number }> } }) => d.metrics.teams.reduce((a, t) => a + t.impactTotal, 0);
    // ratings FAIR,GOOD,VG,EXC → 100 skill points; stamina 1..4 → off; BIG 20×3 + 3 others 2×3 = 78
    expect(total(after)).toBe(100 + 78);
    expect(total(after)).not.toBe(total(before));
  });
});

describe("Apply Swap (preview only, server-authoritative)", () => {
  it("OWNER applies the deterministic suggestion; response is the swapped preview with fresh analysis; nothing persisted or sent", async () => {
    await signInAs("owner@example.test");
    const res = await swap(UNEVEN);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.teams.map((t: { players: Array<{ id: string }> }) => t.players.map((p) => p.id))).toEqual([["good", "vg"], ["exc", "fair"]]);
    expect(data.analysis).toMatchObject({ quality: "EVEN", impactSpread: 0, improvable: false, bestSwap: null });
    expect(data.metrics).toMatchObject({ metricsVersion: METRICS_VERSION, impactSpread: 0 });
    expect(JSON.stringify(data.teams)).not.toMatch(/telegram|900001/i); // preview player shape is allow-listed
    expect(await prisma.teamGeneration.count()).toBe(0);
    expect(await prisma.messageDelivery.count()).toBe(0);
    expect(networkCalls).toBe(0);
  });

  it("ADMIN and MEMBER may apply (same access as Generate); anonymous 401; another Organization 404", async () => {
    await signInAs("admin@example.test");
    expect((await swap(UNEVEN)).status).toBe(200);
    await signInAs("member@example.test");
    expect((await swap(UNEVEN)).status).toBe(200);
    session = null;
    expect((await swap(UNEVEN)).status).toBe(401);
    await signInAs("owner-b@example.test");
    expect((await swap(UNEVEN)).status).toBe(404);
  });

  it("foreign, unknown or duplicated player ids fail with the generic message (no existence leak)", async () => {
    await signInAs("owner@example.test");
    const generic = { error: "One or more players are invalid or unavailable." };
    for (const teams of [
      [{ teamNumber: 1, playerIds: ["exc", "foreign"] }, { teamNumber: 2, playerIds: ["good", "fair"] }],
      [{ teamNumber: 1, playerIds: ["exc", "nope"] }, { teamNumber: 2, playerIds: ["good", "fair"] }],
      [{ teamNumber: 1, playerIds: ["exc", "exc"] }, { teamNumber: 2, playerIds: ["good", "fair"] }],
    ]) {
      const res = await swap({ teams, swap: { playerA: "exc", playerB: "good" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(generic);
    }
    // Org B's owner cannot use Org A's ids through Org B's own group either.
    await signInAs("owner-b@example.test");
    const res = await swap(UNEVEN, G("b-other", "org-b"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(generic);
  });

  it("spoofed rating/stamina/role/metrics/analysis are ignored; only the current server suggestion can be applied", async () => {
    await signInAs("owner@example.test");
    const spoofed = {
      teams: [
        { teamNumber: 1, playerIds: ["exc", "vg"], players: [{ id: "exc", rating: "FAIR", stamina: 1, position: "GOALKEEPER" }], metrics: { impactSpread: 0 } },
        { teamNumber: 2, playerIds: ["good", "fair"] },
      ],
      swap: { playerA: "vg", playerB: "fair" }, // not the suggestion (exc↔good is first in stable order)
      analysis: { quality: "EVEN", bestSwap: { playerA: "vg", playerB: "fair" } },
      quality: "EVEN",
    };
    const res = await swap(spoofed);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.analysis).toMatchObject({ quality: "UNEVEN", impactSpread: 40, bestSwap: { playerA: "exc", playerB: "good" } });
    expect(await prisma.player.findUniqueOrThrow({ where: { id: "exc" } })).toMatchObject({ rating: "EXCELLENT", stamina: 3, position: "PLAYER" });
    // A same-team "swap" or a swap on already-even teams is refused the same way.
    expect((await swap({ ...UNEVEN, swap: { playerA: "exc", playerB: "vg" } })).status).toBe(409);
    const even = { teams: [{ teamNumber: 1, playerIds: ["exc", "fair"] }, { teamNumber: 2, playerIds: ["vg", "good"] }], swap: { playerA: "exc", playerB: "vg" } };
    expect((await swap(even)).status).toBe(409);
  });

  it("malformed bodies are rejected", async () => {
    await signInAs("owner@example.test");
    expect((await swap({ teams: [{ teamNumber: 1, playerIds: ["exc"] }], swap: { playerA: "exc", playerB: "good" } })).status).toBe(400);
    expect((await swap({ teams: UNEVEN.teams })).status).toBe(400);
    const notJson = await swapRoute.POST(new Request("http://itest.local/", { method: "POST", body: "x" }), g(G("other")));
    expect(notJson.status).toBe(415);
  });
});

describe("Publish persists metrics-v2 + analysis; legacy rows stay readable", () => {
  it("publishing the swapped preview stores the resulting teams and the M8 analysis (no swap, ids or text)", async () => {
    await signInAs("owner@example.test");
    const swapped = await (await swap(UNEVEN)).json();
    const res = await publishRoute.POST(json("POST", { date: "2026-10-12T00:00:00.000Z", teams: swapped.teams }), g(G("other")));
    expect(res.status).toBe(200);
    const row = await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "got" } });
    expect(JSON.parse(row.teamsJson).map((t: { players: Array<{ id: string }> }) => t.players.map((p) => p.id))).toEqual([["good", "vg"], ["exc", "fair"]]);
    const parsed = parseStoredMetrics(row.metricsJson);
    expect(parsed.version).toBe("metrics-v2");
    const stored = JSON.parse(row.metricsJson!);
    expect(stored.metricsVersion).toBe(METRICS_VERSION);
    expect(stored.analysis).toMatchObject({ analysisVersion: ANALYSIS_VERSION, quality: "EVEN", improvable: false, impactSpread: 0 });
    expect(row.metricsJson).not.toMatch(/bestSwap|summary|"id"|\b(Ann|Bo|Cy|Di)\b|"(exc|vg|good|fair)"/); // exact ids/names
    expect(row.metricsJson).not.toMatch(/telegram|email|phone|whatsapp|token|session|firstName|lastName/i);
    expect(await prisma.messageDelivery.count()).toBe(0);
  });

  it("pre-M7 (null) and M7 (unversioned) metrics remain readable and untouched", async () => {
    const legacy = await prisma.teamGeneration.create({ data: { groupId: "gs", date: new Date("2026-01-05T00:00:00Z"), teamsJson: "[]" } });
    const m7 = await prisma.teamGeneration.create({
      data: { groupId: "gbb", date: new Date("2026-10-01T00:00:00Z"), teamsJson: "[]", sportKey: "basketball", engineVersion: "balance-v2", metricsJson: JSON.stringify({ teamCount: 2, playerCount: 4, teams: [], sizeSpread: 0, impactSpread: 0 }) },
    });
    await signInAs("owner@example.test");
    const ids = await addPlayers("gs", ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"]);
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(G("soccer")))).json();
    await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams }), g(G("soccer")));
    expect(await prisma.teamGeneration.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await prisma.teamGeneration.findUniqueOrThrow({ where: { id: m7.id } })).toEqual(m7);
    expect(parseStoredMetrics(legacy.metricsJson)).toEqual({ version: "none" });
    expect(parseStoredMetrics(m7.metricsJson).version).toBe("metrics-v1");
  });
});

describe("network safety", () => {
  it("no network call happened", () => {
    expect(networkCalls).toBe(0);
  });
});
