/**
 * M8.1 — REAL-DATABASE tests for pairwise fixture results.
 *
 *  - A 3-team match has 3 fixtures (every pair once); save validates against
 *    the PUBLISHED team set (missing / duplicate / foreign / self pairs and
 *    per-team scores are rejected); save ≠ publish; publish needs the whole
 *    fixture set; nothing is ever sent by save/publish/POTM/recap.
 *  - Published fixtures reach every consumer: public match page, organizer
 *    overview, My Games (truthful per-fixture record), standard recap and the
 *    Match Summary (captured by a Telegram STUB — no network).
 *  - Historical rows keep working: a two-team row reads as one fixture and
 *    re-saves byte-identically; a pre-M8.1 per-team row for 3 teams is shown
 *    as labeled legacy standings and never rewritten.
 *  - MEMBER and other tenants: 404 for every result mutation; no balancing
 *    data in player-facing payloads.
 *
 *  - Position balancing through the real Generate route (stored ratings,
 *    live rng): the 18-player / 3-team / 4-defender class never leaves a team
 *    without a defender; metrics expose the role distribution; MEMBER 404.
 *
 * Guarded local TEST database only.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { getMatchSummaryReadiness, postGameView } from "@/lib/postGame";
import { loadMatchForViewer } from "@/lib/matchPage";
import { loadMyGames } from "@/lib/myGames";
import { loadGroupOverview } from "@/lib/groupOverview";
import { FIXTURES_FORMAT } from "@/lib/matchResults";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-10-05T12:00:00Z");
const BASE = "https://tbp.itest";

const player = (id: string, firstName: string) => ({ id, firstName, lastName: "Test", position: "MIDFIELDER", rating: "EXCELLENT", stamina: 5 });
const TEAMS3 = JSON.stringify([
  { teamNumber: 1, players: [player("p1", "Mel"), player("p2", "Two")] },
  { teamNumber: 2, players: [player("p3", "Three"), player("p4", "Four")] },
  { teamNumber: 3, players: [player("p5", "Five"), player("p6", "Six")] },
]);
const TEAMS2 = JSON.stringify([
  { teamNumber: 1, players: [player("p1", "Mel"), player("p2", "Two"), player("p3", "Three")] },
  { teamNumber: 2, players: [player("p4", "Four"), player("p5", "Five"), player("p6", "Six")] },
]);
const FULL = [
  { teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 },
  { teamA: 2, teamB: 3, scoreA: 4, scoreB: 2 },
  { teamA: 1, teamB: 3, scoreA: 3, scoreB: 3 },
];

// ------------------------------------------------------------ network guard + Telegram stub
let tgSends: Array<{ method: string; text: string }> = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  tgSends.push({ method: u.split("/").pop()!, text: String(body.text ?? "") });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
}

const signIn = async (who: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};
const pg = async (matchId: string, body: unknown, at = A) => {
  const res = await postGameRoute.POST(new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never, {
    params: Promise.resolve({ ...at, matchId }),
  } as never);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const view = async (matchId: string) => postGameView(await requireTenantContextForSlugs(A), matchId);
const publicView = async (matchId: string) => {
  const s = session;
  session = null;
  try {
    return await loadMatchForViewer({ ...A, matchId });
  } finally {
    session = s;
  }
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "A", slug: "org-a", plan: "LEGACY" }, { id: "org-b", name: "B", slug: "org-b", plan: "LEGACY" }] });
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
    data: ["p1", "p2", "p3", "p4", "p5", "p6"].map((id, i) => ({ id, groupId: "ga", firstName: ["Mel", "Two", "Three", "Four", "Five", "Six"][i], lastName: "Test", position: "MIDFIELDER", rating: "EXCELLENT", stamina: 5, userId: id === "p1" ? "u-member" : null })),
  });
  const chat = await prisma.telegramChat.create({ data: { chatId: BigInt(-5001), title: "Group chat", groupId: "ga" } });
  const day = (n: number) => new Date(Date.UTC(2026, 9, 5 + n));
  await prisma.match.createMany({
    data: [
      { id: "m3", groupId: "ga", date: day(-1), startTime: "19:00", telegramChatId: chat.id },
      { id: "m2-legacy", groupId: "ga", date: day(-7) },
      { id: "m3-legacy", groupId: "ga", date: day(-14) },
      { id: "mb", groupId: "gb", date: day(-1) },
    ],
  });
  await prisma.teamGeneration.createMany({
    data: [
      { id: "g3", groupId: "ga", matchId: "m3", date: day(-1), teamsJson: TEAMS3 },
      { id: "g2", groupId: "ga", matchId: "m2-legacy", date: day(-7), teamsJson: TEAMS2 },
      { id: "g3l", groupId: "ga", matchId: "m3-legacy", date: day(-14), teamsJson: TEAMS3 },
      { id: "gb1", groupId: "gb", matchId: "mb", date: day(-1), teamsJson: TEAMS2 },
    ],
  });
  // Historical rows written before M8.1 (never rewritten by reads).
  await prisma.matchResult.createMany({
    data: [
      { groupId: "ga", matchId: "m2-legacy", scoresJson: '[{"teamNumber":1,"score":7},{"teamNumber":2,"score":5}]', publishedAt: NOW },
      { groupId: "ga", matchId: "m3-legacy", scoresJson: '[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3},{"teamNumber":3,"score":2}]', publishedAt: NOW },
    ],
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("OPENAI_API_KEY", "");
});
beforeEach(async () => {
  session = null;
  tgSends = [];
  otherNetwork = 0;
  await seed();
  await signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("3 teams → 3 fixtures: validation, save ≠ publish, nothing sent", () => {
  it("the organizer view lists every pair once", async () => {
    expect((await view("m3"))!.fixturePairs).toEqual([[1, 2], [1, 3], [2, 3]]);
  });

  it("rejects per-team scores, missing, duplicate, foreign and self pairs (nothing stored)", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }, { teamNumber: 3, score: 2 }] }, /every fixture/],
      [{ fixtures: FULL.slice(0, 2) }, /missing: Team 1 vs Team 3/],
      [{ fixtures: [...FULL, { teamA: 2, teamB: 1, scoreA: 1, scoreB: 1 }] }, /more than once/],
      [{ fixtures: [FULL[0], FULL[1], { teamA: 1, teamB: 4, scoreA: 1, scoreB: 0 }] }, /published teams/],
      [{ fixtures: [FULL[0], FULL[1], { teamA: 3, teamB: 3, scoreA: 1, scoreB: 0 }] }, /itself/],
      [{ fixtures: FULL, scores: [{ teamNumber: 1, score: 1 }, { teamNumber: 2, score: 0 }] }, /fixture/],
    ];
    for (const [body, error] of bad) {
      const r = await pg("m3", { action: "save_result", ...(body as object) });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.body.error)).toMatch(error);
    }
    expect((await pg("m3", { action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: -1, scoreB: 0 }] })).status).toBe(400); // schema
    expect(await prisma.matchResult.count({ where: { matchId: "m3" } })).toBe(0);
  });

  it("save stores the whole set atomically and does NOT publish; publish is explicit; neither sends", async () => {
    const saved = await pg("m3", { action: "save_result", fixtures: FULL });
    expect(saved).toEqual({ status: 200, body: { ok: true, published: false } });
    const row = await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m3" } });
    expect(row.publishedAt).toBeNull();
    expect(JSON.parse(row.scoresJson)).toEqual({
      format: FIXTURES_FORMAT,
      fixtures: [
        { teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 },
        { teamA: 1, teamB: 3, scoreA: 3, scoreB: 3 },
        { teamA: 2, teamB: 3, scoreA: 4, scoreB: 2 },
      ],
    });
    // Unpublished: invisible to the public page, My Games and the overview.
    expect((await publicView("m3"))!.result).toBeNull();
    expect((await loadMyGames("u-member", NOW))[0].recent.find((g) => g.matchId === "m3")).toMatchObject({ result: null, myRecord: [] });
    expect((await loadGroupOverview(await requireTenantContextForSlugs(A))).past.find((m) => m.id === "m3")?.publishedResult).toBeNull();
    expect((await view("m3"))!.result).toMatchObject({ published: false, complete: true });

    expect(await pg("m3", { action: "publish_result" })).toEqual({ status: 200, body: { ok: true } });
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m3" } })).status).toBe("COMPLETED");
    expect(tgSends).toEqual([]);
    expect(await prisma.messageDelivery.count()).toBe(0);
  });

  it("publish requires the complete fixture set for the CURRENT published teams", async () => {
    await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m3", scoresJson: JSON.stringify({ format: FIXTURES_FORMAT, fixtures: FULL.slice(0, 2) }) } });
    const r = await pg("m3", { action: "publish_result" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/every fixture/);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m3" } })).publishedAt).toBeNull();
  });
});

describe("published fixtures reach every consumer", () => {
  beforeEach(async () => {
    await pg("m3", { action: "save_result", fixtures: FULL });
    await pg("m3", { action: "publish_result" });
  });

  it("public match page: all three fixtures with their own winner/draw — no '5 – 3 – 2', no balancing data", async () => {
    const v = (await publicView("m3"))!;
    expect(v.result).toEqual({
      fixtures: [
        { teamA: 1, teamB: 2, scoreA: 5, scoreB: 3, winner: 1 },
        { teamA: 1, teamB: 3, scoreA: 3, scoreB: 3, winner: null },
        { teamA: 2, teamB: 3, scoreA: 4, scoreB: 2, winner: 2 },
      ],
      legacyStandings: null,
    });
    expect(JSON.stringify(v)).not.toMatch(/rating|stamina|EXCELLENT|winnerTeamNumber/);
  });

  it("organizer overview: published fixtures", async () => {
    const o = await loadGroupOverview(await requireTenantContextForSlugs(A));
    expect(o.past.find((m) => m.id === "m3")?.publishedResult?.fixtures).toHaveLength(3);
  });

  it("My Games: Team 1's own fixtures (W vs Team 2, D vs Team 3) — no invented overall W/D/L", async () => {
    const g = (await loadMyGames("u-member", NOW))[0].recent.find((x) => x.matchId === "m3")!;
    expect(g.myTeam.teamNumber).toBe(1);
    expect(g.myRecord).toEqual([
      { opponent: 2, scoreFor: 5, scoreAgainst: 3, outcome: "W" },
      { opponent: 3, scoreFor: 3, scoreAgainst: 3, outcome: "D" },
    ]);
  });

  it("recap: the standard recap and the AI fallback contain every fixture (AI not configured → no request)", async () => {
    const expected = "Team 1 beat Team 2 5–3, Team 1 drew with Team 3 3–3, and Team 2 beat Team 3 4–2.";
    expect((await view("m3"))!.standardRecap).toContain(expected);
    const ai = await pg("m3", { action: "generate_recap" });
    expect(ai.status).toBe(503);
    expect(String(ai.body.fallback)).toContain(expected);
    expect(otherNetwork).toBe(0);
  });

  it("Player of the Match: one match-level selection after the published result; publishing sends nothing", async () => {
    expect((await pg("m3", { action: "save_mvp_selection", playerId: "p4" })).status).toBe(200);
    expect((await pg("m3", { action: "publish_mvp" })).status).toBe(200);
    expect((await publicView("m3"))!.mvp).toEqual({ names: ["Four Test"], shared: false });
    expect(tgSends).toEqual([]);
  });

  it("Match Summary: readiness includes the result; ONLY the explicit post sends, with every fixture", async () => {
    await pg("m3", { action: "save_recap", content: "Great night." });
    await pg("m3", { action: "publish_recap" });
    const ready = (await getMatchSummaryReadiness(await requireTenantContextForSlugs(A), "m3"))!;
    expect(ready).toMatchObject({ resultPublished: true, destinationConnected: true, canPost: true });
    expect(tgSends).toEqual([]);
    const posted = await pg("m3", { action: "post_message", kind: "summary" });
    expect(posted.status).toBe(200);
    expect(tgSends.map((s) => s.method)).toEqual(["sendMessage"]);
    const text = tgSends[0].text;
    for (const line of ["Team 1  5 — 3  Team 2", "Team 1  3 — 3  Team 3", "Team 2  4 — 2  Team 3", "Great night."]) expect(text).toContain(line);
    expect(text).not.toMatch(/wins!|🤝 Draw/); // no invented overall result
    expect(otherNetwork).toBe(0);
  });
});

describe("historical results keep working", () => {
  it("two-team row: one fixture everywhere; re-saving it writes the identical bytes; still publishable", async () => {
    const before = (await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m2-legacy" } })).scoresJson;
    expect((await publicView("m2-legacy"))!.result).toEqual({ fixtures: [{ teamA: 1, teamB: 2, scoreA: 7, scoreB: 5, winner: 1 }], legacyStandings: null });
    expect((await view("m2-legacy"))!.result).toMatchObject({ published: true, complete: true, fixtures: [{ scoreA: 7, scoreB: 5 }] });
    expect((await loadMyGames("u-member", NOW))[0].recent.find((g) => g.matchId === "m2-legacy")!.myRecord).toEqual([{ opponent: 2, scoreFor: 7, scoreAgainst: 5, outcome: "W" }]);
    // The pre-M8.1 request shape still works for two teams; the stored bytes are unchanged.
    expect((await pg("m2-legacy", { action: "save_result", scores: [{ teamNumber: 2, score: 5 }, { teamNumber: 1, score: 7 }] })).body).toEqual({ ok: true, published: true });
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m2-legacy" } })).scoresJson).toBe(before);
    expect((await pg("m2-legacy", { action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 7, scoreB: 5 }] })).status).toBe(200);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m2-legacy" } })).scoresJson).toBe(before);
  });

  it("pre-M8.1 per-team row for 3 teams: labeled legacy standings, never rewritten by reads; organizer can replace it with fixtures", async () => {
    const before = (await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m3-legacy" } })).scoresJson;
    expect((await publicView("m3-legacy"))!.result).toEqual({ fixtures: [], legacyStandings: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }, { teamNumber: 3, score: 2 }] });
    expect((await view("m3-legacy"))!.result).toMatchObject({ published: true, complete: false });
    expect((await loadMyGames("u-member", NOW))[0].recent.find((g) => g.matchId === "m3-legacy")!.myRecord).toEqual([]);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: "m3-legacy" } })).scoresJson).toBe(before);
    expect((await pg("m3-legacy", { action: "save_result", fixtures: FULL })).body).toEqual({ ok: true, published: true });
    expect((await publicView("m3-legacy"))!.result?.fixtures).toHaveLength(3);
  });
});

describe("authorization and tenancy unchanged", () => {
  it("MEMBER: every result mutation is the generic 404; nothing stored", async () => {
    await signIn("member");
    for (const body of [{ action: "save_result", fixtures: FULL }, { action: "publish_result" }]) expect((await pg("m3", body)).status).toBe(404);
    expect(await prisma.matchResult.count({ where: { matchId: "m3" } })).toBe(0);
  });
  it("another Organization: 404 on this Group's match; this Group's URL cannot reach the other Group's match", async () => {
    await signIn("other");
    expect((await pg("m3", { action: "save_result", fixtures: FULL })).status).toBe(404);
    await signIn("owner");
    expect((await pg("mb", { action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 1, scoreB: 0 }] })).status).toBe(404);
    expect((await pg("mb", { action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 1, scoreB: 0 }] }, B)).status).toBe(404);
    expect(await prisma.matchResult.count({ where: { matchId: "mb" } })).toBe(0);
  });
});

describe("position-aware generation through the real Generate route", () => {
  // The production case class: soccer, 18 selected players, 3 teams, 4 defenders, 3 goalkeepers.
  const ROLES: string[] = ["GOALKEEPER", "GOALKEEPER", "GOALKEEPER", "DEFENDER", "DEFENDER", "DEFENDER", "DEFENDER", ...Array(6).fill("MIDFIELDER"), ...Array(4).fill("FORWARD"), "ANY"];
  const RATINGS = ["EXCELLENT", "VERY_GOOD", "GOOD", "FAIR"] as const;
  beforeEach(async () => {
    await prisma.player.createMany({
      data: ROLES.map((position, i) => ({ id: `r${i}`, groupId: "ga", firstName: `R${i}`, lastName: "Gen", position, rating: RATINGS[i % 4], stamina: 1 + (i % 5) })),
    });
  });
  const generate = async () => {
    const res = await generateRoute.POST(
      new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamCount: 3, date: "2026-10-12", selectedIds: ROLES.map((_, i) => `r${i}`) }) }) as never,
      { params: Promise.resolve(A) } as never
    );
    return { status: res.status, body: (await res.json()) as { teams: Array<{ players: Array<{ position: string }> }>; metrics: { roleDistribution?: Array<{ roleKey: string; perTeam: number[]; excess: number }>; impactSpread: number }; engineVersion: string } };
  };
  it("every run: one goalkeeper per team, every team has a defender (2/1/1), equal sizes; exposed in metrics", async () => {
    for (let run = 0; run < 25; run++) {
      const { status, body } = await generate();
      expect(status).toBe(200);
      const per = (role: string) => body.teams.map((t) => t.players.filter((p) => p.position === role).length);
      expect(per("GOALKEEPER")).toEqual([1, 1, 1]);
      expect([...per("DEFENDER")].sort()).toEqual([1, 1, 2]);
      expect(body.teams.map((t) => t.players.length)).toEqual([6, 6, 6]);
      expect(body.engineVersion).toBe("balance-v3");
      expect(body.metrics.roleDistribution?.find((d) => d.roleKey === "DEFENDER")).toMatchObject({ excess: 0 });
    }
    expect(await prisma.teamGeneration.count({ where: { date: new Date("2026-10-12") } })).toBe(0); // preview only
  });
  it("MEMBER cannot generate (404)", async () => {
    await signIn("member");
    expect((await generate()).status).toBe(404);
  });
});
