/**
 * UI-6 — REAL-DATABASE tests for My Games (player experience) and the
 * Organization page's tenant boundary, across identity states:
 * OWNER without / with a claimed Player, MEMBER-player, a User with no
 * claimed Player, multiple profiles, and cross-tenant attempts.
 * My Games must carry no balancing data (skill / stamina / metrics) and only
 * PUBLISHED post-game data. Guarded local TEST database only.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { loadMyGames } from "@/lib/myGames";
import { requireOrganizationContextForSlug, TenantContextError } from "@/lib/tenantContext";
import { listOrganizationMembers } from "@/lib/invitations";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-10-05T12:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 9, 5 + n));
const TEAMS = JSON.stringify([
  { teamNumber: 1, players: [{ id: "pm", firstName: "Mel", lastName: "Member", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 }, { id: "p2", firstName: "Two", lastName: "Mate", position: "FORWARD", rating: "FAIR", stamina: 1 }] },
  { teamNumber: 2, players: [{ id: "p3", firstName: "Three", lastName: "Opp", position: "DEFENDER", rating: "GOOD", stamina: 3 }, { id: "po", firstName: "Owen", lastName: "Owner", position: "FORWARD", rating: "VERY_GOOD", stamina: 4 }] },
]);
const userId = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
const signIn = async (email: string) => (session = { user: { id: await userId(email), email } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: ["owner", "owner2", "member", "loner", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
  });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "Org A", slug: "org-a", plan: "LEGACY" }, { id: "org-b", name: "Org B", slug: "org-b", plan: "LEGACY" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Indoor", slug: "indoor", sportKey: "soccer", timezone: "UTC" },
      { id: "gb", organizationId: "org-b", name: "Hoops", slug: "hoops", sportKey: "basketball", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-owner2", organizationId: "org-a", role: "ADMIN" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other", organizationId: "org-b", role: "OWNER" },
    ],
  });
  await prisma.player.createMany({
    data: [
      { id: "pm", groupId: "ga", userId: "u-member", firstName: "Mel", lastName: "Member", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 },
      { id: "po", groupId: "ga", userId: "u-owner", firstName: "Owen", lastName: "Owner", position: "FORWARD", rating: "VERY_GOOD", stamina: 4 },
      { id: "p2", groupId: "ga", firstName: "Two", lastName: "Mate", position: "FORWARD", rating: "FAIR", stamina: 1 },
      { id: "p3", groupId: "ga", firstName: "Three", lastName: "Opp", position: "DEFENDER", rating: "GOOD", stamina: 3 },
      // The same MEMBER user also plays in another Organization's Group (claimed there too).
      { id: "pmb", groupId: "gb", userId: "u-member", firstName: "Mel", lastName: "M", position: "GUARD", rating: "GOOD", stamina: 2 },
    ],
  });
  await prisma.match.createMany({
    data: [
      { id: "m-next", groupId: "ga", date: day(2), startTime: "19:00", locationName: "Field 2" },
      { id: "m-later", groupId: "ga", date: day(9) },
      { id: "m-done", groupId: "ga", date: day(-3) },
      { id: "m-draft", groupId: "ga", date: day(-1) },
      { id: "m-cancel", groupId: "ga", date: day(-2), status: "CANCELED" },
      { id: "m-b", groupId: "gb", date: day(4) },
    ],
  });
  await prisma.attendanceResponse.create({ data: { matchId: "m-next", groupId: "ga", playerId: "pm", participantStatus: "MAYBE", participantSource: "WEB", participantRespondedAt: NOW } });
  for (const [id, matchId] of [["tg-done", "m-done"], ["tg-draft", "m-draft"], ["tg-cancel", "m-cancel"]] as const)
    await prisma.teamGeneration.create({ data: { id, groupId: "ga", matchId, date: day(-3), teamsJson: TEAMS } });
  // m-done: everything published. m-draft: result saved but NOT published; MVP vote open; recap saved not published.
  await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m-done", scoresJson: JSON.stringify([{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }]), publishedAt: NOW } });
  await prisma.matchMvp.create({ data: { groupId: "ga", matchId: "m-done", winnerPlayerIds: ["po"], method: "ORGANIZER_SELECTION", selectedPlayerId: "po", publishedAt: NOW } });
  await prisma.matchRecap.create({ data: { groupId: "ga", matchId: "m-done", content: "Team 1 ran away with it.", publishedContent: "Team 1 ran away with it.", source: "MANUAL", publishedAt: NOW } });
  await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m-draft", scoresJson: JSON.stringify([{ teamNumber: 1, score: 9 }, { teamNumber: 2, score: 9 }]) } });
  await prisma.matchMvp.create({ data: { groupId: "ga", matchId: "m-draft", candidatePlayerIds: ["pm", "p2", "p3", "po"], openedAt: NOW, method: "PLAYER_VOTE" } });
  await prisma.matchRecap.create({ data: { groupId: "ga", matchId: "m-draft", content: "SECRET DRAFT", source: "MANUAL" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
});
beforeEach(async () => {
  session = null;
  await seed();
});
afterAll(() => prisma.$disconnect());

describe("My Games — identity states", () => {
  it("1/4: an ADMIN without a claimed Player, and a User with no membership and no Player, get NO games (nothing is created)", async () => {
    const before = await prisma.player.count();
    expect(await loadMyGames(await userId("owner2@example.test"), NOW)).toEqual([]);
    expect(await loadMyGames(await userId("loner@example.test"), NOW)).toEqual([]);
    expect(await prisma.player.count()).toBe(before);
  });

  it("3: MEMBER-player: one profile per claimed Player, across Organizations; upcoming games with own attendance", async () => {
    const profiles = await loadMyGames(await userId("member@example.test"), NOW);
    expect(profiles.map((p) => [p.organizationName, p.groupName, p.sportLabel, p.displayName])).toEqual([
      ["Org A", "Indoor", "Soccer", "Mel Member"],
      ["Org B", "Hoops", "Basketball", "Mel M"],
    ]);
    const a = profiles[0];
    expect(a.upcoming.map((g) => g.matchId)).toEqual(["m-next", "m-later"]);
    expect(a.upcoming[0]).toMatchObject({ myStatus: "MAYBE", myStatusByOrganizer: false, attendanceClosed: false, teamsPublished: false, myTeam: null, matchHref: "/g/org-a/indoor/m/m-next" });
    expect(profiles[1].upcoming.map((g) => g.matchId)).toEqual(["m-b"]);
  });

  it("recent games: only Matches I played in (canceled excluded); PUBLISHED result / Player of the Match / recap only", async () => {
    const [a] = await loadMyGames(await userId("member@example.test"), NOW);
    expect(a.recent.map((g) => g.matchId)).toEqual(["m-draft", "m-done"]);
    const [draft, done] = a.recent;
    expect(done).toMatchObject({
      myTeam: { teamNumber: 1, teammates: ["Two Mate"] },
      result: { fixtures: [{ teamA: 1, teamB: 2, scoreA: 3, scoreB: 1, winner: 1 }], legacyStandings: null },
      myRecord: [{ opponent: 2, scoreFor: 3, scoreAgainst: 1, outcome: "W" }],
      mvp: { names: ["Owen Owner"], shared: false },
      recap: { text: "Team 1 ran away with it." },
      mvpVoteOpen: false,
    });
    expect(draft).toMatchObject({ result: null, mvp: null, recap: null, mvpVoteOpen: true }); // unpublished data never shown
  });

  it("2: an OWNER with a claimed Player sees their own player view (Team 2)", async () => {
    const [o] = await loadMyGames(await userId("owner@example.test"), NOW);
    expect(o.displayName).toBe("Owen Owner");
    expect(o.recent.find((g) => g.matchId === "m-done")?.myTeam).toEqual({ teamNumber: 2, teammates: ["Three Opp"] });
  });

  it("no balancing data, other Players' ids or unpublished content anywhere in the payload", async () => {
    const json = JSON.stringify(await loadMyGames(await userId("member@example.test"), NOW));
    expect(json).not.toMatch(/rating|stamina|EXCELLENT|VERY_GOOD|FAIR|impact|metrics|weight/i);
    expect(json).not.toMatch(/"p2"|"p3"|"po"|SECRET DRAFT|"score":9/);
  });

  it("5: cross-tenant — a Player claimed by another User is never shown; another Organization's page is rejected", async () => {
    const other = await loadMyGames(await userId("other@example.test"), NOW);
    expect(other).toEqual([]);
    await signIn("other@example.test");
    await expect(requireOrganizationContextForSlug({ organizationSlug: "org-a" })).rejects.toBeInstanceOf(TenantContextError);
    await signIn("loner@example.test");
    await expect(requireOrganizationContextForSlug({ organizationSlug: "org-a" })).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("Organization page data", () => {
  it("members & invitations stay OWNER-only server-side (ADMIN / MEMBER rejected)", async () => {
    await signIn("owner@example.test");
    const owner = await listOrganizationMembers(await requireOrganizationContextForSlug({ organizationSlug: "org-a" }));
    expect(owner.members).toHaveLength(3);
    for (const who of ["owner2", "member"]) {
      await signIn(`${who}@example.test`);
      const ctx = await requireOrganizationContextForSlug({ organizationSlug: "org-a" });
      await expect(listOrganizationMembers(ctx)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    }
  });
});
