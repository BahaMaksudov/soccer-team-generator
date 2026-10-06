/**
 * UI-4A — organizer mutation authorization matrix (REAL DATABASE).
 *
 * Policy: OWNER and ADMIN are organizers; MEMBER is read-only on organizer
 * surfaces. Every organizer mutation is enforced SERVER-SIDE (the existing
 * managersOnlyResponse / requireRole helpers → the generic 404, no capability
 * leak) — these tests call the real route handlers directly, as a manual API
 * request would, so hidden buttons play no part.
 *
 * Player participation is separate and must keep working for a MEMBER who
 * has claimed a Player: self-attendance (/api/account/...) and Player of the
 * Match voting through the Telegram poll.
 *
 * Guarded local TEST database only; global fetch is a counting guard (no
 * Telegram / OpenAI / email). Managers' Telegram/AI actions are exercised
 * only up to the point that proves authorization (no destination / no key).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { applyTelegramMvpAnswer } from "@/lib/telegramMvp";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as syncRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/sync/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as matchChatRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/telegram-chat/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as swapRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/swap/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";
import * as claimRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/claim/route";
import * as teamNameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/team-name/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";
import * as visibilityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/visibility/route";
import * as shareLinkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/share-link/route";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as selfAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const FUTURE = "2099-06-01";
const PAST = "2026-01-10";
const req = (method: string, body?: unknown, url = "http://itest.local/") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const g = { params: Promise.resolve(A) };
const gm = (matchId: string) => ({ params: Promise.resolve({ ...A, matchId }) });
const gp = (id: string) => ({ params: Promise.resolve({ ...A, id }) });

const TEAMS = [
  { teamNumber: 1, players: [{ id: "p1", firstName: "Ann", lastName: "One", position: "DEFENDER" }, { id: "p2", firstName: "Bo", lastName: "Two", position: "FORWARD" }] },
  { teamNumber: 2, players: [{ id: "p3", firstName: "Cy", lastName: "Three", position: "DEFENDER" }, { id: "p4", firstName: "Di", lastName: "Four", position: "FORWARD" }] },
];

let networkCalls = 0;
const originalFetch = global.fetch;
const signIn = async (email: string | null) => {
  if (!email) return void (session = null);
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email } };
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: ["owner", "admin", "member", "outsider", "other-owner"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })),
  });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "Org A", slug: "org-a" }, { id: "org-b", name: "Org B", slug: "org-b" }] });
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
      { userId: "u-other-owner", organizationId: "org-b", role: "OWNER" },
    ],
  });
  await prisma.player.createMany({
    data: [
      // MEMBER has claimed p1; the outsider (no membership at all) has claimed p2.
      { id: "p1", groupId: "ga", userId: "u-member", firstName: "Ann", lastName: "One", position: "DEFENDER", rating: "EXCELLENT", stamina: 5 },
      { id: "p2", groupId: "ga", userId: "u-outsider", firstName: "Bo", lastName: "Two", position: "FORWARD", rating: "GOOD", stamina: 3 },
      { id: "p3", groupId: "ga", firstName: "Cy", lastName: "Three", position: "DEFENDER", rating: "GOOD", stamina: 3 },
      { id: "p4", groupId: "ga", firstName: "Di", lastName: "Four", position: "FORWARD", rating: "VERY_GOOD", stamina: 4 },
    ],
  });
  await prisma.telegramUserLink.create({ data: { groupId: "ga", userId: 5001n, playerId: "p1" } });
  await prisma.match.createMany({
    data: [
      { id: "m-up", groupId: "ga", date: new Date(`${FUTURE}T00:00:00Z`) },
      { id: "m-past", groupId: "ga", date: new Date(`${PAST}T00:00:00Z`) },
      { id: "m-vote", groupId: "ga", date: new Date(`${PAST}T00:00:00Z`) },
    ],
  });
  for (const [id, matchId] of [["tg-past", "m-past"], ["tg-vote", "m-vote"]] as const)
    await prisma.teamGeneration.create({ data: { id, groupId: "ga", matchId, date: new Date(`${PAST}T00:00:00Z`), teamsJson: JSON.stringify(TEAMS) } });
  // m-vote: published result + an OPEN player vote (Telegram poll among participants)
  await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m-vote", scoresJson: JSON.stringify([{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 1 }]), publishedAt: new Date() } });
  await prisma.matchMvp.create({ data: { groupId: "ga", matchId: "m-vote", candidatePlayerIds: ["p1", "p2", "p3", "p4"], openedAt: new Date(), method: "PLAYER_VOTE" } });
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

/** Every organizer capability: [label, call]. Each runs on a fresh seed. */
type Cap = [string, () => Promise<Response>];
const pg = (matchId: string, body: unknown) => () => postGameRoute.POST(req("POST", body), gm(matchId));
const CAPS: Cap[] = [
  ["create match", () => matchesRoute.POST(req("POST", { date: FUTURE }), g)],
  ["edit match", () => matchRoute.PATCH(req("PATCH", { locationName: "Field 9" }), gm("m-up"))],
  ["mark completed", () => matchRoute.PATCH(req("PATCH", { status: "COMPLETED" }), gm("m-up"))],
  ["cancel match", () => matchRoute.PATCH(req("PATCH", { status: "CANCELED" }), gm("m-up"))],
  ["reopen match", () => matchRoute.PATCH(req("PATCH", { status: "SCHEDULED" }), gm("m-past"))],
  ["attendance override", () => overrideRoute.POST(req("POST", { playerId: "p3", status: "PLAYING" }), gm("m-up"))],
  ["clear override", () => overrideRoute.POST(req("POST", { playerId: "p3", status: null }), gm("m-up"))],
  ["close attendance", () => closeRoute.POST(req("POST", { closed: true }), gm("m-up"))],
  ["reopen attendance", () => closeRoute.POST(req("POST", { closed: false }), gm("m-up"))],
  ["sync Telegram attendance", () => syncRoute.POST(req("POST", {}), gm("m-up"))],
  ["generate teams", () => generateRoute.POST(req("POST", { teamCount: 2, date: FUTURE, selectedIds: ["p1", "p2", "p3", "p4"] }), g)],
  ["apply swap", () => swapRoute.POST(req("POST", { date: FUTURE, teams: TEAMS }), g)],
  ["publish teams", () => publishRoute.POST(req("POST", { date: FUTURE, teams: TEAMS, matchId: "m-up" }), g)],
  ["delete published teams by date", () => publishRoute.DELETE(req("DELETE", undefined, `http://itest.local/?date=${PAST}`), g)],
  ["save result", pg("m-past", { action: "save_result", scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }] })],
  ["publish result", pg("m-vote", { action: "publish_result" })],
  ["start MVP vote", pg("m-past", { action: "start_mvp", intent: "post" })],
  ["close MVP vote", pg("m-vote", { action: "close_mvp" })],
  ["save MVP selection", pg("m-past", { action: "save_mvp_selection", playerId: "p1" })],
  ["reset MVP selection", pg("m-past", { action: "reset_mvp_selection" })],
  ["publish MVP", pg("m-vote", { action: "publish_mvp" })],
  ["generate AI recap", pg("m-vote", { action: "generate_recap" })],
  ["save recap", pg("m-vote", { action: "save_recap", content: "A tight game." })],
  ["publish recap", pg("m-vote", { action: "publish_recap" })],
  ["post Match Summary", pg("m-vote", { action: "post_message", kind: "summary", intent: "post" })],
  ["post attendance poll", () => pollRoute.POST(req("POST", { chatRef: 1, intent: "post" }), gm("m-up"))],
  ["choose match Telegram group", () => matchChatRoute.POST(req("POST", { chatRef: null }), gm("m-up"))],
  ["post teams to Telegram", () => closePostRoute.POST(req("POST", { pollId: "none", teamGenerationId: "tg-past" }), g)],
  ["add player", () => playersRoute.POST(req("POST", { firstName: "New", lastName: "Player", position: "DEFENDER", rating: "GOOD", stamina: 3 }), g)],
  ["edit player", () => playerRoute.PATCH(req("PATCH", { firstName: "Renamed" }), gp("p3"))],
  ["deactivate player", () => playerRoute.PATCH(req("PATCH", { isActive: false }), gp("p3"))],
  ["delete player", () => playerRoute.DELETE(req("DELETE"), gp("p4"))],
  ["create claim link", () => claimRoute.POST(req("POST", {}), gp("p3"))],
  ["save team name", () => teamNameRoute.PUT(req("PUT", { teamName: "Renamed" }), g)],
  ["save balance weights", () => weightsRoute.PUT(req("PUT", { weights: { staminaCoef: 1 } }), g)],
  ["change visibility", () => visibilityRoute.PUT(req("PUT", { visibility: "LINK" }), g)],
  ["create share link", () => shareLinkRoute.POST(req("POST", {}), g)],
];

/** Everything an organizer mutation could touch, for "MEMBER changed nothing" checks. */
async function fingerprint() {
  const rows = await Promise.all([
    prisma.match.findMany({ orderBy: { id: "asc" } }),
    prisma.attendanceResponse.findMany({ orderBy: { id: "asc" } }),
    prisma.teamGeneration.findMany({ orderBy: { id: "asc" } }),
    prisma.matchResult.findMany({ orderBy: { id: "asc" } }),
    prisma.matchMvp.findMany({ orderBy: { id: "asc" } }),
    prisma.matchRecap.findMany({ orderBy: { id: "asc" } }),
    prisma.messageDelivery.findMany({ orderBy: { id: "asc" } }),
    prisma.player.findMany({ orderBy: { id: "asc" } }),
    prisma.playerClaim.findMany({ orderBy: { id: "asc" } }),
    prisma.groupSetting.findMany({ orderBy: { id: "asc" } }),
    prisma.groupShareLink.findMany({ orderBy: { id: "asc" } }),
    prisma.group.findMany({ orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

describe("organizer mutation matrix — MEMBER is denied server-side (generic 404, nothing changes)", () => {
  it.each(CAPS)("%s", async (_label, call) => {
    await signIn("member@example.test");
    const before = await fingerprint();
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    expect(await fingerprint()).toBe(before);
  });
});

describe("organizer mutation matrix — OWNER and ADMIN pass authorization", () => {
  // Authorized = not the generic denial. Telegram/AI actions stop at their own
  // preconditions here (no Telegram group / no AI key) — that proves the role
  // check passed without contacting any provider.
  for (const email of ["owner@example.test", "admin@example.test"]) {
    it.each(CAPS)(`${email.split("@")[0]}: %s`, async (label, call) => {
      await signIn(email);
      const res = await call();
      const body = await res.clone().json().catch(() => ({}));
      expect(res.status, JSON.stringify(body)).not.toBe(401);
      expect(body?.error, JSON.stringify(body)).not.toBe("NOT_FOUND");
      // AI is not configured here: the existing "not set up" answer (503) proves authorization passed.
      if (label === "generate AI recap") expect(body.error).toBe("AI recaps are not set up. Use the standard recap instead.");
      else expect(res.status).toBeLessThan(500);
    });
  }
});

describe("reads stay available to every member", () => {
  it.each(["owner", "admin", "member"])("%s can view the group's matches and a match", async (who) => {
    await signIn(`${who}@example.test`);
    expect((await matchesRoute.GET(req("GET"), g)).status).toBe(200);
    expect((await matchRoute.GET(req("GET"), gm("m-past"))).status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("another Organization's OWNER cannot mutate (or read) this Group", async () => {
    await signIn("other-owner@example.test");
    const before = await fingerprint();
    for (const [label, call] of CAPS) expect((await call()).status, label).toBe(404);
    expect((await matchesRoute.GET(req("GET"), g)).status).toBe(404);
    expect(await fingerprint()).toBe(before);
  });
  it("signed out → 401", async () => {
    await signIn(null);
    expect((await matchesRoute.POST(req("POST", { date: FUTURE }), g)).status).toBe(401);
  });
});

describe("player participation is separate and unchanged", () => {
  it("a MEMBER with a claimed Player sets their OWN attendance (account route), but cannot override anyone's", async () => {
    await signIn("member@example.test");
    const res = await selfAttendanceRoute.POST(req("POST", { status: "PLAYING" }), { params: Promise.resolve({ matchId: "m-up" }) });
    expect(res.status).toBe(200);
    expect(await prisma.attendanceResponse.findFirstOrThrow({ where: { matchId: "m-up", playerId: "p1" } })).toMatchObject({ participantStatus: "PLAYING", participantSource: "WEB", overrideStatus: null });
    expect((await overrideRoute.POST(req("POST", { playerId: "p1", status: "NOT_PLAYING" }), gm("m-up"))).status).toBe(404);
  });
  it("a claimed Player WITHOUT any membership: self-attendance works, organizer routes are 404", async () => {
    await signIn("outsider@example.test");
    expect((await selfAttendanceRoute.POST(req("POST", { status: "MAYBE" }), { params: Promise.resolve({ matchId: "m-up" }) })).status).toBe(200);
    expect((await matchRoute.GET(req("GET"), gm("m-up"))).status).toBe(404);
    expect((await matchesRoute.POST(req("POST", { date: FUTURE }), g)).status).toBe(404);
  });
  it("Player of the Match voting (Telegram poll answer) still records for an eligible participant who is a MEMBER", async () => {
    const outcome = await prisma.$transaction((tx) => applyTelegramMvpAnswer(tx, { matchId: "m-vote", groupId: "ga", telegramUserId: 5001n, optionIds: [2] }));
    expect(outcome).toBe("recorded");
    expect(await prisma.matchMvpVote.count({ where: { matchId: "m-vote", voterPlayerId: "p1" } })).toBe(1);
    // …and voting grants nothing organizer-side
    await signIn("member@example.test");
    expect((await postGameRoute.POST(req("POST", { action: "close_mvp" }), gm("m-vote"))).status).toBe(404);
  });
});
