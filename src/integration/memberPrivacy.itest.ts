/**
 * UI-7 — MEMBER player-data privacy (server-side) + a full no-Telegram match
 * workflow regression.
 *
 *  - OWNER / ADMIN receive rating + stamina from the players API and the match
 *    workspace roster; MEMBER's SERIALIZED responses contain neither key.
 *  - Team generation still reads ratings/stamina from the database (MEMBER
 *    DTO sanitization never touches balancing input).
 *  - Create → attendance → close → generate → publish → result → Player of the
 *    Match (organizer selection) → standard recap → readiness: every step works
 *    and nothing is sent (no MessageDelivery, no network).
 *
 * Guarded local TEST database only; global fetch is a counting guard.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { getMatchSummaryReadiness } from "@/lib/postGame";
import { loadMatchForViewer } from "@/lib/matchPage";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const g = { params: Promise.resolve(A) };
const gm = (matchId: string) => ({ params: Promise.resolve({ ...A, matchId }) });
const req = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const signIn = async (email: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email } };
};
let networkCalls = 0;
const originalFetch = global.fetch;
const RATINGS = ["EXCELLENT", "EXCELLENT", "GOOD", "GOOD", "FAIR", "FAIR"] as const;

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "A", slug: "org-a" }, { id: "org-b", name: "B", slug: "org-b" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC", visibility: "PUBLIC" },
      { id: "gb", organizationId: "org-b", name: "Group B", slug: "group-b", sportKey: "soccer", timezone: "UTC" },
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
  await prisma.player.createMany({
    data: RATINGS.map((rating, i) => ({ id: `p${i + 1}`, groupId: "ga", firstName: `P${i + 1}`, lastName: "Test", position: i % 2 ? "FORWARD" : "DEFENDER", rating, stamina: (i % 5) + 1, userId: i === 0 ? "u-member" : null })),
  });
  await prisma.match.create({ data: { id: "m1", groupId: "ga", date: new Date("2026-03-01T00:00:00Z") } });
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
  vi.unstubAllEnvs();
  vi.stubEnv("OPENAI_API_KEY", "");
  await seed();
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
  expect(networkCalls).toBe(0);
});

const playersJson = async () => {
  const res = await playersRoute.GET(req("GET"), g);
  return { status: res.status, text: await res.text() };
};
const matchJson = async () => {
  const res = await matchRoute.GET(req("GET"), gm("m1"));
  return { status: res.status, text: await res.text() };
};

describe("players API — serialized response by role", () => {
  it.each(["owner", "admin"])("%s receives rating and stamina", async (who) => {
    await signIn(`${who}@example.test`);
    const { status, text } = await playersJson();
    expect(status).toBe(200);
    const list = JSON.parse(text);
    expect(list).toHaveLength(6);
    expect(list.find((p: { id: string }) => p.id === "p1")).toMatchObject({ rating: "EXCELLENT", stamina: 1, claimPending: false });
  });
  it("MEMBER: no rating / stamina / claim-link state keys in the JSON; safe fields kept", async () => {
    await signIn("member@example.test");
    const { status, text } = await playersJson();
    expect(status).toBe(200);
    expect(text).not.toMatch(/"rating"|"stamina"|"claimPending"|EXCELLENT|VERY_GOOD|"FAIR"|"GOOD"/);
    expect(JSON.parse(text)[0]).toEqual({ id: expect.any(String), firstName: expect.any(String), lastName: "Test", position: expect.any(String), isActive: true, accountClaimed: expect.any(Boolean), telegramConnected: false, communityIds: expect.any(Array) }); // M9.2 — memberships are roster data
  });
  it("another Organization: 404", async () => {
    await signIn("other@example.test");
    expect((await playersJson()).status).toBe(404);
  });
});

describe("match workspace roster — serialized response by role", () => {
  it.each(["owner", "admin"])("%s roster carries rating and stamina", async (who) => {
    await signIn(`${who}@example.test`);
    const { status, text } = await matchJson();
    expect(status).toBe(200);
    expect(JSON.parse(text).roster.find((p: { id: string }) => p.id === "p2")).toMatchObject({ rating: "EXCELLENT", stamina: 2 });
  });
  it("MEMBER roster: no rating / stamina keys anywhere in the JSON; names, positions and attendance kept", async () => {
    await signIn("member@example.test");
    const { status, text } = await matchJson();
    expect(status).toBe(200);
    expect(text).not.toMatch(/"rating"|"stamina"|EXCELLENT|VERY_GOOD|"FAIR"|"GOOD"/);
    const roster = JSON.parse(text).roster;
    expect(roster).toHaveLength(6);
    expect(roster[0]).toHaveProperty("attendance");
    expect(roster[0]).toHaveProperty("position");
  });
  it("another Organization: 404", async () => {
    await signIn("other@example.test");
    expect((await matchJson()).status).toBe(404);
  });
});

describe("balancing / generation unaffected by MEMBER sanitization", () => {
  it("generation reads ratings from the DATABASE (MEMBER reads change nothing)", async () => {
    await signIn("member@example.test");
    await playersJson();
    await matchJson();
    await signIn("owner@example.test");
    const body = { teamCount: 2, date: "2026-03-01", selectedIds: ["p1", "p2", "p3", "p4", "p5", "p6"] };
    const a = await (await generateRoute.POST(req("POST", body), g)).json();
    const b = await (await generateRoute.POST(req("POST", body), g)).json();
    // Live Generate uses Math.random by design (re-running may give another valid split;
    // the engine is deterministic for a given rng — see the parity suite). What must hold
    // on every run: the balancing input is the stored ratings.
    const total = (r: { metrics: { teams: Array<{ skillCounts: Record<string, number> }> } }) =>
      r.metrics.teams.reduce((acc, t) => (Object.entries(t.skillCounts).forEach(([k, n]) => (acc[k] = (acc[k] ?? 0) + n)), acc), {} as Record<string, number>);
    expect(total(a)).toEqual(total(b));
    const skill = (a.metrics.teams as Array<{ skillCounts: Record<string, number> }>).reduce(
      (acc, t) => (Object.entries(t.skillCounts).forEach(([k, n]) => (acc[k] = (acc[k] ?? 0) + n)), acc),
      {} as Record<string, number>
    );
    expect(skill).toEqual({ FAIR: 2, GOOD: 2, VERY_GOOD: 0, EXCELLENT: 2 }); // = stored ratings
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p1" } })).rating).toBe("EXCELLENT");
    // A rating change in the DB (not in any client payload) changes the metrics.
    await prisma.player.update({ where: { id: "p5" }, data: { rating: "VERY_GOOD" } });
    const c = await (await generateRoute.POST(req("POST", body), g)).json();
    const skill2 = (c.metrics.teams as Array<{ skillCounts: Record<string, number> }>).reduce((n, t) => n + t.skillCounts.VERY_GOOD, 0);
    expect(skill2).toBe(1);
  });
});

describe("match workflow regression (OWNER, nothing sent)", () => {
  it("create → attendance → close → generate → publish → result → POTM → standard recap → readiness", async () => {
    await signIn("owner@example.test");
    const created = await (await matchesRoute.POST(req("POST", { date: "2026-03-05", startTime: "19:00", locationName: "Field 2" }), g)).json();
    const id = created.match.id as string;
    expect((await matchRoute.PATCH(req("PATCH", { locationName: "Field 3" }), gm(id))).status).toBe(200);
    for (const pid of ["p1", "p2", "p3", "p4"]) expect((await overrideRoute.POST(req("POST", { playerId: pid, status: "PLAYING" }), gm(id))).status).toBe(200);
    expect((await closeRoute.POST(req("POST", { closed: true }), gm(id))).status).toBe(200);
    const view = await (await matchRoute.GET(req("GET"), gm(id))).json();
    expect(view.defaultSelection.sort()).toEqual(["p1", "p2", "p3", "p4"]);

    const gen = await (await generateRoute.POST(req("POST", { teamCount: 2, date: "2026-03-05", selectedIds: view.defaultSelection }), g)).json();
    expect(gen.teams).toHaveLength(2);
    expect(await prisma.teamGeneration.count()).toBe(0); // preview is not persisted
    expect((await publishRoute.POST(req("POST", { date: gen.date, teams: gen.teams, matchId: id }), g)).status).toBe(200);
    expect(await prisma.teamGeneration.count({ where: { matchId: id } })).toBe(1);

    const pg = (body: unknown) => postGameRoute.POST(req("POST", body), gm(id));
    expect((await pg({ action: "save_result", scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }] })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.result).toBeNull(); // saved ≠ published
    expect((await pg({ action: "publish_result" })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.result).toMatchObject({ fixtures: [{ winner: 1 }] });

    const participant = (await prisma.teamGeneration.findFirstOrThrow({ where: { matchId: id } })).teamsJson.match(/"id":"(p\d)"/)![1];
    expect((await pg({ action: "save_mvp_selection", playerId: participant })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.mvp).toBeNull();
    expect((await pg({ action: "publish_mvp" })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.mvp?.names).toHaveLength(1);

    const pgView = (await (await matchRoute.GET(req("GET"), gm(id))).json()).postGame;
    expect(pgView.standardRecap).toEqual(expect.any(String));
    expect((await pg({ action: "save_recap", content: pgView.standardRecap })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.recap).toBeNull();
    expect((await pg({ action: "publish_recap" })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.recap?.text).toBe(pgView.standardRecap);
    // M9.1 — saving an edit of a PUBLISHED recap does not publish it: players keep the
    // published text until the organizer explicitly publishes the change.
    expect((await pg({ action: "save_recap", content: "Edited after publishing." })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.recap?.text).toBe(pgView.standardRecap);
    expect((await pg({ action: "publish_recap" })).status).toBe(200);
    expect((await loadMatchForViewer({ ...A, matchId: id }))?.recap?.text).toBe("Edited after publishing.");

    const ctx = await requireTenantContextForSlugs(A);
    const readiness = await getMatchSummaryReadiness(ctx, id);
    expect(readiness?.items.map((i) => [i.key, i.included])).toEqual([["result", true], ["mvp", true], ["recap", true]]);
    expect(readiness?.destinationConnected).toBe(false); // no Telegram group → cannot post; nothing was posted
    expect(await prisma.messageDelivery.count()).toBe(0); // result / POTM / recap publish never send
  });
});

describe("UI-7 — legacy Delete-by-date never removes a Match's published teams", () => {
  it("deletes only the legacy by-date set for that date; the Match-linked set (same date) survives; MEMBER 404", async () => {
    const teams = JSON.stringify([{ teamNumber: 1, players: [] }, { teamNumber: 2, players: [] }]);
    const day = new Date("2026-03-01T00:00:00Z");
    await prisma.teamGeneration.create({ data: { id: "legacy", groupId: "ga", date: day, teamsJson: teams } });
    await prisma.teamGeneration.create({ data: { id: "match", groupId: "ga", matchId: "m1", date: day, teamsJson: teams } });
    const del = () => publishRoute.DELETE(new Request("http://itest.local/?date=2026-03-01", { method: "DELETE" }), g);

    await signIn("member@example.test");
    expect((await del()).status).toBe(404);
    expect(await prisma.teamGeneration.count()).toBe(2);

    await signIn("owner@example.test");
    const res = await del();
    expect(await res.json()).toMatchObject({ ok: true, deleted: 1 });
    expect((await prisma.teamGeneration.findMany({ select: { id: true } })).map((r) => r.id)).toEqual(["match"]);
  });
});
