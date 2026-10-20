/**
 * M9.3 — Web-only participation & sharing, REAL DATABASE (guarded local test
 * DB only). Telegram is a stub that counts calls (a web-only Community must
 * make ZERO); email goes to the in-memory outbox. MATCH_SHARE_SECRET is a fake
 * test value.
 *
 * Scenario: Group A ("Monday Night Soccer", LINK) with Community "Monday Night
 * Players" (no Telegram) and Community "Weekend" (another roster); Group B is
 * another tenant.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as shareRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/share/route";
import * as shareResetRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/share/reset/route";
import * as linkViewRoute from "@/app/api/share/match/route";
import * as linkAnswerRoute from "@/app/api/share/match/attendance/route";
import * as personalLinksRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/personal-links/route";
import * as attendAnswerRoute from "@/app/api/attend/answer/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import * as schedulesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/schedules/route";
import * as visibilityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/visibility/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { matchPlayerRef, matchShareToken } from "@/lib/matchShare";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { setOwnAttendance } from "@/lib/matches";
import { createShareLink } from "@/lib/shareLinks";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { testOutbox } from "@/lib/email/transport";

const A = { organizationSlug: "org-a", groupSlug: "monday" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const SECRET = "m93-integration-test-secret-0123456789abcdef";
const ORIGIN = "http://itest.local";

// ------------------------------------------------------------ Telegram stub (counts every call)
let tgCalls: string[] = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  tgCalls.push(u.split("/").pop()!);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, poll: { id: `p-${tgCalls.length}` } } }) } as unknown as Response;
}

const json = (method: string, body?: unknown, url = `${ORIGIN}/`, headers: Record<string, string> = {}) =>
  new Request(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const g = (at = A) => ({ params: Promise.resolve(at) });
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

// Anonymous Match Link calls (no session).
const view = (token: unknown, matchId: unknown, playerRef?: string) => call(linkViewRoute.POST(json("POST", { token, matchId, ...(playerRef ? { playerRef } : {}) }, `${ORIGIN}/api/share/match`)));
// M12B — the shared-link answer route ignores the request entirely (always 410); the body is kept for readability.
const answer = (body: Record<string, unknown>, origin: string | null = ORIGIN) => (void body, void origin, call(linkAnswerRoute.POST()));

const PLAYERS = [
  ["john", "John", "Smith"],
  ["jane", "Jane", "Smythe"],
  ["mike", "Michael", "Brown"],
  ["mia", "Mia", "Brown"],
  ["ann", "Ann", ""],
  ["old", "Olga", "Inactive"],
  ["weekend", "Wendy", "End"],
] as const;
const MONDAY = ["john", "jane", "mike", "mia", "ann", "old"];

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PersonalAttendanceLink","MatchAutomationEmail","MatchAutomation","MatchSchedule","Venue","MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","CommunityPlayer","Community","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupShareLink","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other", "claimed"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "Boston Soccer Club", slug: "org-a", plan: "LEGACY" }, { id: "org-b", name: "B", slug: "org-b", plan: "LEGACY" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Monday Night Soccer", slug: "monday", sportKey: "soccer", timezone: "America/New_York", visibility: "LINK" },
      { id: "gb", organizationId: "org-b", name: "Other", slug: "group-b", sportKey: "soccer", timezone: "UTC", visibility: "LINK" },
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
    data: PLAYERS.map(([id, firstName, lastName], i) => ({ id, groupId: "ga", firstName, lastName, position: i % 2 ? "DEFENDER" : "MIDFIELDER", rating: "GOOD", stamina: 3, isActive: id !== "old" })),
  });
  await prisma.player.update({ where: { id: "john" }, data: { userId: "u-claimed" } });
  await prisma.player.create({ data: { id: "b1", groupId: "gb", firstName: "B", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 3 } });
  await prisma.community.createMany({
    data: [
      { id: "c-mon", groupId: "ga", name: "Monday Night Players" },
      { id: "c-wk", groupId: "ga", name: "Weekend" },
    ],
  });
  await prisma.communityPlayer.createMany({
    data: [...MONDAY.map((playerId) => ({ groupId: "ga", communityId: "c-mon", playerId })), { groupId: "ga", communityId: "c-wk", playerId: "weekend" }],
  });
  await prisma.match.createMany({
    data: [
      { id: "m1", groupId: "ga", communityId: "c-mon", date: new Date("2099-10-12T00:00:00Z"), startTime: "21:00", locationName: "ForeKicks" },
      { id: "m2", groupId: "ga", communityId: "c-mon", date: new Date("2099-10-19T00:00:00Z"), startTime: "21:00" },
      { id: "mb", groupId: "gb", date: new Date("2099-10-12T00:00:00Z"), startTime: "21:00" },
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
  vi.stubEnv("APP_BASE_URL", ORIGIN);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@tbp.itest>");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});
beforeEach(async () => {
  vi.stubEnv("MATCH_SHARE_SECRET", SECRET);
  session = null;
  tgCalls = [];
  otherNetwork = 0;
  testOutbox.clear();
  await seed();
  await signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

const tokenOf = async (matchId: string) => matchShareToken(matchId, (await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).shareVersion)!;
const refOf = async (matchId: string, playerId: string) => matchPlayerRef(matchId, (await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).shareVersion, playerId)!;
const row = (matchId: string, playerId: string) => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId, playerId } } });
const organizerView = async (matchId: string) => (await call(matchRoute.GET(json("GET"), gm(matchId)))).body as { counts: Record<string, number>; rosterSize: number; roster: Array<{ id: string; attendance: { status: string | null; source: string | null } }> };

// ============================================================ SHARING (organizer)
describe("M9.3 — organizer Share Match", () => {
  it("OWNER and ADMIN get the same current link repeatedly; message parts are the real match values", async () => {
    const first = await call(shareRoute.GET(json("GET"), gm("m1")));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ available: true, message: { title: "Monday Night Players", when: "Monday, Oct 12 · 9:00 PM", venue: "ForeKicks" } });
    expect(first.body.path).toBe(`/share/m/m1#${await tokenOf("m1")}`);
    expect((await call(shareRoute.GET(json("GET"), gm("m1")))).body.path).toBe(first.body.path); // re-copyable
    await signIn("admin");
    expect((await call(shareRoute.GET(json("GET"), gm("m1")))).body.path).toBe(first.body.path);
    expect((await call(shareRoute.GET(json("GET"), gm("m2")))).body.path).not.toBe(first.body.path); // per Match
  });

  it("MEMBER cannot see or reset the link; other tenants and foreign ids get 404", async () => {
    await signIn("member");
    expect((await call(shareRoute.GET(json("GET"), gm("m1")))).status).toBe(404);
    expect((await call(shareResetRoute.POST(json("POST"), gm("m1")))).status).toBe(404);
    await signIn("other");
    expect((await call(shareRoute.GET(json("GET"), gm("m1", B)))).status).toBe(404);
    expect((await call(shareResetRoute.POST(json("POST"), gm("m1", B)))).status).toBe(404);
    await signIn("owner");
    expect((await call(shareRoute.GET(json("GET"), gm("mb")))).status).toBe(404); // Group B's match through Group A's URL
    expect((await prisma.match.findUniqueOrThrow({ where: { id: "m1" } })).shareVersion).toBe(1);
  });

  it("Reset Link invalidates the previous link immediately; the new link works; attendance is untouched", async () => {
    const oldToken = await tokenOf("m1");
    await prisma.attendanceResponse.create({ data: { matchId: "m1", groupId: "ga", playerId: "jane", participantStatus: "PLAYING", participantSource: "TELEGRAM", participantRespondedAt: new Date() } });
    const reset = await call(shareResetRoute.POST(json("POST"), gm("m1")));
    expect(reset.body).toMatchObject({ ok: true, available: true });
    const newToken = await tokenOf("m1");
    expect(newToken).not.toBe(oldToken);
    expect(reset.body.path).toBe(`/share/m/m1#${newToken}`);
    expect((await view(oldToken, "m1")).status).toBe(404);
    expect((await view(newToken, "m1")).status).toBe(200);
    expect((await row("m1", "jane"))!.participantStatus).toBe("PLAYING");
  });

  it("fails safely without MATCH_SHARE_SECRET (organizer message; links neither issued nor accepted); PRIVATE groups get an explanation", async () => {
    const token = await tokenOf("m1");
    vi.stubEnv("MATCH_SHARE_SECRET", "");
    const r = await call(shareRoute.GET(json("GET"), gm("m1")));
    expect(r).toMatchObject({ status: 503, body: { available: false, reason: "not_configured" } });
    expect(String(r.body.error)).toMatch(/aren't set up/);
    expect((await view(token, "m1")).status).toBe(404);
    vi.stubEnv("MATCH_SHARE_SECRET", "too-short");
    expect((await call(shareRoute.GET(json("GET"), gm("m1")))).status).toBe(503);
    vi.stubEnv("MATCH_SHARE_SECRET", SECRET);
    await call(visibilityRoute.PUT(json("PUT", { visibility: "PRIVATE" }), g()));
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "ga" } })).visibility).toBe("PRIVATE");
    expect(await call(shareRoute.GET(json("GET"), gm("m1")))).toMatchObject({ status: 409, body: { available: false, reason: "private" } });
    expect((await view(token, "m1")).status).toBe(404); // PRIVATE disables the link
  });
});

// ============================================================ ANONYMOUS VIEW + PRIVACY
describe("M9.3 — anonymous Match Link view", () => {
  it("one Match only: a token for m1 never opens m2 or another tenant's match; garbage is the same 404", async () => {
    const t1 = await tokenOf("m1");
    for (const [token, matchId] of [
      [t1, "m2"],
      [t1, "mb"],
      ["x".repeat(43), "m1"],
      [null, "m1"],
      [t1, "nope"],
      [t1, { id: "m1" }],
    ] as const) {
      const r = await view(token, matchId);
      expect(r, JSON.stringify([token, matchId])).toEqual({ status: 404, body: { error: "This link is not valid." } });
    }
  });

  it("M12B — VIEW-ONLY: no roster, no player references, no 'me'; says how players answer; nothing private leaks", async () => {
    const r = await view(await tokenOf("m1"), "m1", "anything");
    expect(r.status).toBe(200);
    expect(r.body.link).toEqual({ communityName: "Monday Night Players", state: "open", mode: "web" });
    expect(r.body).not.toHaveProperty("me");
    const text = JSON.stringify(r.body);
    for (const id of ["john", "jane", "mike", "mia", "ann", "old", "weekend", "u-claimed", "c-mon", "ga", "org-a"]) expect(text).not.toContain(`"${id}"`);
    expect(text).not.toMatch(/roster|ref"|Jane|Michael|rating|stamina|skill|weight|email|userId|telegram|automation|shareVersion|Smith|Smythe|Brown|GOOD|lastError|cutoff/i);
    // A connected Telegram group (Pro-capable org) makes it a Telegram match: the page says "vote in the poll".
    const chat = await prisma.telegramChat.create({ data: { chatId: -9301n, title: "Mon chat", groupId: "ga", communityId: "c-mon" } });
    await prisma.match.update({ where: { id: "m1" }, data: { telegramChatId: chat.id } });
    expect(((await view(await tokenOf("m1"), "m1")).body.link as { mode: string }).mode).toBe("telegram");
  });

  it("only PUBLISHED post-game content is visible; drafts never appear", async () => {
    const t = await tokenOf("m1");
    await prisma.matchRecap.create({ data: { groupId: "ga", matchId: "m1", content: "DRAFT recap", source: "MANUAL" } });
    await prisma.matchResult.create({ data: { groupId: "ga", matchId: "m1", scoresJson: JSON.stringify([{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }]) } });
    const r = await view(t, "m1");
    expect(r.body).toMatchObject({ teamsPublished: false, result: null, mvp: null, recap: null });
    expect(JSON.stringify(r.body)).not.toContain("DRAFT");
  });

  it("the Group share link keeps working read-only for its matches (no roster, no answers)", async () => {
    const ctx = await requireTenantContextForSlugs(A);
    const { token } = await createShareLink(ctx);
    const r = await view(token, "m1");
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("link");
    expect((await answer({ token, matchId: "m1", playerRef: await refOf("m1", "jane"), status: "PLAYING" })).status).toBe(410); // never a write capability
  });
});

// ============================================================ M12B: the shared link is view-only
describe("M12B — nobody can answer through the shared Match Link", () => {
  it("every answer is refused (410) — valid link + real player reference, any status, any origin — and nothing is written", async () => {
    const t = await tokenOf("m1");
    for (const playerId of ["jane", "john", "ann"]) {
      for (const status of ["PLAYING", "MAYBE", "NOT_PLAYING"]) {
        const r = await answer({ token: t, matchId: "m1", playerRef: await refOf("m1", playerId), status });
        expect(r).toMatchObject({ status: 410, body: { code: "MATCH_LINK_READ_ONLY" } });
      }
    }
    expect((await answer({ token: t, matchId: "m1", playerRef: await refOf("m1", "jane"), status: "PLAYING" }, "https://evil.example")).status).toBe(410);
    expect(await prisma.attendanceResponse.count()).toBe(0);
  });

  it("a Telegram answer can never be overwritten through the shared link", async () => {
    await prisma.attendanceResponse.create({ data: { matchId: "m1", groupId: "ga", playerId: "jane", participantStatus: "PLAYING", participantSource: "TELEGRAM", participantRespondedAt: new Date() } });
    expect((await answer({ token: await tokenOf("m1"), matchId: "m1", playerRef: await refOf("m1", "jane"), status: "NOT_PLAYING" })).status).toBe(410);
    expect(await row("m1", "jane")).toMatchObject({ participantStatus: "PLAYING", participantSource: "TELEGRAM" });
  });
});

describe("M9.3 — a web-only Community end to end (no Telegram, no player accounts)", () => {
  // The poll step checks "is attendance closed?" against the REAL clock while these scenarios run at fixed
  // instants (Oct 11–13, 2026): pin the clock to the scenario's poll evening so the test doesn't depend on today's date.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:10:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  // Monday 9 PM New York; poll Sunday 8 PM; cutoff Monday 8 PM — game Oct 12, 2026.
  const SCHED = { communityId: "c-mon", timezone: "America/New_York", weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
  const afterPoll = new Date("2026-10-12T00:05:00Z");
  const afterCutoff = new Date("2026-10-13T00:05:00Z");

  it("schedule → Match → personal links → answers → cutoff → email with link → generate → publish → result → POTM → recap → the link shows it all", async () => {
    expect((await call(schedulesRoute.POST(json("POST", SCHED), g()))).status).toBe(201);

    // Poll time: the Match is created; with no Telegram the step completes healthily (no error, no call).
    const run1 = await runMatchAutomation(afterPoll);
    expect(run1).toMatchObject({ created: 1, pollsPosted: 0, errors: [] });
    const m = await prisma.match.findFirstOrThrow({ where: { scheduleId: { not: null } }, include: { automation: true } });
    expect(m.automation).toMatchObject({ lastError: null });
    expect(m.automation!.pollPostedAt).not.toBeNull();
    expect(((await organizerView(m.id)) as unknown as { automation: { channel: string; lastError: string | null } }).automation).toMatchObject({ channel: "link", lastError: null });
    expect(await runMatchAutomation(new Date(afterPoll.getTime() + 15 * 60_000))).toMatchObject({ created: 0, errors: [] });

    // The organizer copies the (view-only) Match Link and — M12B — creates personal attendance links;
    // each player answers for themselves without an account.
    const share = await call(shareRoute.GET(json("GET"), gm(m.id)));
    const token = String(share.body.path).split("#")[1];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(afterPoll.getTime() + 3600_000));
    const personal: Record<string, string> = {};
    try {
      const issued = await call(personalLinksRoute.POST(json("POST", { action: "issue" }), gm(m.id)));
      expect(issued.status).toBe(200);
      for (const l of issued.body.links as Array<{ playerId: string; path: string }>) personal[l.playerId] = l.path.split("#")[1];
      expect(Object.keys(personal).sort()).toEqual(["ann", "jane", "john", "mia", "mike"]);
      for (const [playerId, status] of [["jane", "PLAYING"], ["mike", "PLAYING"], ["mia", "PLAYING"], ["ann", "PLAYING"], ["john", "NOT_PLAYING"]] as const) {
        expect((await call(attendAnswerRoute.POST(json("POST", { token: personal[playerId], status }, `${ORIGIN}/api/attend/answer`, { origin: ORIGIN })))).status, playerId).toBe(200);
      }
    } finally {
      vi.useRealTimers();
    }

    // Cutoff: attendance closes, organizers are emailed (with the Match Link), still no Telegram.
    expect(await runMatchAutomation(afterCutoff)).toMatchObject({ cutoffs: 1, notified: 1, errors: [] });
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m.id } })).attendanceClosedAt).not.toBeNull();
    expect(testOutbox.sent.map((e) => e.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    const mail = testOutbox.sent[0].text;
    expect(mail).toMatch(/Playing: 4 · Maybe: 0 · Not playing: 1 · Not responded: 0 \(roster 5\)/);
    expect(mail).toContain(`${ORIGIN}/share/m/${m.id}#${token}`);
    expect(mail).not.toMatch(/Telegram/);
    expect((await call(attendAnswerRoute.POST(json("POST", { token: personal.jane, status: "MAYBE" }, `${ORIGIN}/api/attend/answer`, { origin: ORIGIN })))).status).toBe(409); // closed

    // The organizer generates and publishes (no Telegram call).
    const date = m.date.toISOString().slice(0, 10);
    const gen = await call(generateRoute.POST(json("POST", { teamCount: 2, date, selectedIds: ["jane", "mike", "mia", "ann"], matchId: m.id }), g()));
    expect(gen.status).toBe(200);
    const pub = await call(publishRoute.POST(json("POST", { date, teams: gen.body.teams, matchId: m.id }), g()));
    expect(pub.status).toBe(200);
    expect(pub.body).not.toHaveProperty("poll"); // website Publish never touches Telegram polls

    // Result, organizer POTM, recap — published.
    const pg = (body: unknown) => call(postGameRoute.POST(json("POST", body), gm(m.id)));
    expect((await pg({ action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 }] })).status).toBe(200);
    expect((await pg({ action: "publish_result" })).status).toBe(200);
    expect((await pg({ action: "save_mvp_selection", playerId: "mia" })).status).toBe(200);
    expect((await pg({ action: "publish_mvp" })).status).toBe(200);
    expect((await pg({ action: "save_recap", content: "Great game on Monday!" })).status).toBe(200);
    expect((await pg({ action: "publish_recap" })).status).toBe(200);

    // The same link shows everything players should see.
    const final = await view(token, m.id);
    expect(final.status).toBe(200);
    expect(final.body).toMatchObject({
      match: { startTime: "21:00" },
      teamsPublished: true,
      result: { fixtures: [{ teamA: 1, teamB: 2, scoreA: 5, scoreB: 3, winner: 1 }] },
      mvp: { names: [expect.stringMatching(/^Mia/)], shared: false },
      recap: { text: "Great game on Monday!" },
      link: { state: "closed" },
    });
    expect((final.body.teams as Array<{ players: unknown[] }>).flatMap((t) => t.players)).toHaveLength(4);
    expect(JSON.stringify(final.body)).not.toMatch(/"(jane|mike|mia|ann|john|ga|c-mon)"/); // no ids
    expect(JSON.stringify(final.body)).not.toMatch(/rating|stamina|email|userId|telegram/i);

    expect(tgCalls).toEqual([]);
    expect(otherNetwork).toBe(0);
  });

  it("a Telegram-connected Community keeps the poll behavior (regression)", async () => {
    await prisma.telegramChat.create({ data: { chatId: -9300n, title: "Monday chat", groupId: "ga", communityId: "c-mon" } });
    await call(schedulesRoute.POST(json("POST", SCHED), g()));
    expect(await runMatchAutomation(afterPoll)).toMatchObject({ created: 1, pollsPosted: 1, errors: [] });
    expect(tgCalls).toEqual(["sendPoll"]);
    const m = await prisma.match.findFirstOrThrow({ where: { scheduleId: { not: null } } });
    expect(((await organizerView(m.id)) as unknown as { automation: { channel: string } }).automation.channel).toBe("telegram");
    expect(await runMatchAutomation(afterCutoff)).toMatchObject({ cutoffs: 1, notified: 1 });
    expect(tgCalls).toContain("stopPoll");
  });
});
