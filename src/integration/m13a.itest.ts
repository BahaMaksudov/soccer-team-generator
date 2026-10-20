/**
 * M13A — REAL DATABASE (guarded local test DB only). Telegram is a stub (no real
 * calls) and email goes to the in-memory test outbox; nothing leaves the machine.
 *
 *   Phase 0 — signed-in website attendance (/me) is refused for TELEGRAM matches
 *             (409 TELEGRAM_MATCH), decided under the Match row lock.
 *   Group invitations — join links, join requests, manual approval.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as ownAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import { setOwnAttendance, TELEGRAM_MATCH_MESSAGE } from "@/lib/matches";
import { loadMyGames } from "@/lib/myGames";
import { applyTelegramAttendanceAnswer } from "@/lib/telegramAttendance";
import { answerPersonal } from "@/lib/personalAttendance";
import { generateToken, hashToken } from "@/lib/secureToken";
import * as joinLinksRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/join-links/route";
import * as joinRequestsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/join-requests/route";
import * as joinDecisionRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/join-requests/[requestId]/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as joinPreviewRoute from "@/app/api/join/route";
import * as joinRequestRoute from "@/app/api/join/request/route";
import * as joinCancelRoute from "@/app/api/join/cancel/route";
import { JOIN_LIMITS, listMyJoinRequests } from "@/lib/groupJoin";

const VERIFIED_AT = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
let tgCalls = 0;
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown): Promise<Response> {
  if (String(url).startsWith("https://api.telegram.org/bot")) {
    tgCalls++;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
  }
  otherNetwork++;
  throw new Error("network access is forbidden in integration tests");
}

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://itest.local/api/x", { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, headers: r.headers, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const gm = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const own = (matchId: string, status: string) => call(ownAttendanceRoute.POST(json("POST", { status }), { params: Promise.resolve({ matchId }) }));
const row = (matchId: string, playerId: string) => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId, playerId } } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PersonalAttendanceLink","MessageDelivery","AttendanceResponse","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","Match","CommunityPlayer","Community","PlayerClaim","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: [
      ...["owner", "admin", "member", "player", "other", "free"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED_AT })),
      { id: "u-unverified", email: "unverified@example.test", name: "unverified", passwordHash: null, emailVerifiedAt: null },
    ],
  });
  await prisma.organization.createMany({
    data: [
      { id: "o", name: "Org", slug: "o", plan: "LEGACY" },
      { id: "o2", name: "Other", slug: "o2", plan: "LEGACY" },
      { id: "of", name: "Free", slug: "of", plan: "FREE" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday Soccer", slug: "g", sportKey: "soccer", timezone: TZ, visibility: "LINK" },
      { id: "gx", organizationId: "o", name: "Second Group", slug: "gx", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other Group", slug: "g2", sportKey: "soccer", timezone: TZ },
      { id: "gf", organizationId: "of", name: "Free Group", slug: "gf", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
      { userId: "u-free", organizationId: "of", role: "OWNER" },
    ],
  });
  const P = (id: string, groupId: string, firstName: string, userId: string | null = null) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, userId });
  await prisma.player.createMany({ data: [P("p1", "g", "Pat", "u-player"), P("p2", "g", "Sam"), P("p3", "g", "Kim"), P("x1", "g2", "Xen", "u-other")] });
  await prisma.telegramUserLink.create({ data: { groupId: "g", userId: 111n, playerId: "p1" } });
}
const webMatch = (id: string, data: Record<string, unknown> = {}) => prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", ...data } });
async function telegramMatch(id: string, chatId = -100n) {
  const chat = await prisma.telegramChat.create({ data: { chatId, title: "Chat", groupId: "g" } });
  await prisma.match.create({ data: { id, groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", telegramChatId: chat.id } });
  await prisma.telegramPoll.create({ data: { pollId: `poll-${id}`, chatId, messageId: 9n, question: "Playing?", optionsJson: "[]", pollDate: new Date("2099-06-03"), groupId: "g", matchId: id, kind: "ATTENDANCE" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
});
beforeEach(async () => {
  tgCalls = 0;
  await seed();
  signIn("player");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("M13A Phase 0 — signed-in website attendance is refused for Telegram matches", () => {
  it("website-only match: the signed-in player's own answer is recorded (WEB)", async () => {
    await webMatch("mw");
    expect(await own("mw", "PLAYING")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await row("mw", "p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "WEB" });
  });

  it("Telegram match (poll): 409 TELEGRAM_MATCH, nothing written", async () => {
    await telegramMatch("mt");
    expect(await own("mt", "PLAYING")).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH", error: TELEGRAM_MATCH_MESSAGE } });
    expect(await row("mt", "p1")).toBeNull();
  });

  it("Telegram match (connected chat, no poll yet): 409 too", async () => {
    const chat = await prisma.telegramChat.create({ data: { chatId: -300n, title: "C", groupId: "g" } });
    await webMatch("mc", { telegramChatId: chat.id });
    expect((await own("mc", "MAYBE")).body).toMatchObject({ code: "TELEGRAM_MATCH" });
    expect(await row("mc", "p1")).toBeNull();
  });

  it("the Telegram vote stays authoritative: a later website attempt changes nothing", async () => {
    await telegramMatch("mt");
    expect(await prisma.$transaction((tx) => applyTelegramAttendanceAnswer(tx, { matchId: "mt", groupId: "g", telegramUserId: 111n, optionIds: [0], at: new Date() }))).toBe("recorded");
    expect((await own("mt", "NOT_PLAYING")).status).toBe(409);
    expect(await row("mt", "p1")).toMatchObject({ participantStatus: "PLAYING", participantSource: "TELEGRAM" });
  });

  it("/me: Telegram matches are poll-only; website-only matches keep their buttons", async () => {
    await webMatch("mw", { date: new Date("2099-06-01") });
    await telegramMatch("mt");
    const [profile] = await loadMyGames("u-player");
    expect(profile.upcoming.map((g) => [g.matchId, g.attendanceMode])).toEqual([
      ["mw", "web"],
      ["mt", "telegram"],
    ]);
  });

  it("stale page: /me loaded while web-only, then a poll is posted → the old buttons' request is refused", async () => {
    await webMatch("mw");
    expect((await loadMyGames("u-player"))[0].upcoming[0].attendanceMode).toBe("web");
    await prisma.telegramPoll.create({ data: { pollId: "late", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
    expect((await own("mw", "PLAYING")).body).toMatchObject({ code: "TELEGRAM_MATCH" });
    expect(await row("mw", "p1")).toBeNull();
  });

  it("race: a poll being inserted concurrently (uncommitted) — the website answer waits for it and is refused", async () => {
    await webMatch("mw");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const pollInserted = new Promise<void>((r) => (inserted = r));
    const posting = prisma.$transaction(
      async (tx) => {
        await tx.telegramPoll.create({ data: { pollId: "racing", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
        inserted();
        await gate; // hold the poll insert (and its FOR KEY SHARE on the Match row) open
      },
      { timeout: 20_000 }
    );
    await pollInserted;
    const answering = setOwnAttendance("u-player", "mw", "PLAYING");
    const early = await Promise.race([answering.then(() => "finished"), new Promise((r) => setTimeout(() => r("waiting"), 400))]);
    expect(early).toBe("waiting"); // blocked on the Match row lock
    release();
    await posting;
    expect(await answering).toBe("telegram");
    expect(await row("mw", "p1")).toBeNull();
  });

  it("race (M12B personal link): same guarantee", async () => {
    await webMatch("mw");
    const token = generateToken();
    await prisma.personalAttendanceLink.create({ data: { organizationId: "o", groupId: "g", matchId: "mw", playerId: "p2", tokenHash: hashToken(token) } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const pollInserted = new Promise<void>((r) => (inserted = r));
    const posting = prisma.$transaction(
      async (tx) => {
        await tx.telegramPoll.create({ data: { pollId: "racing2", chatId: -1n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mw", kind: "ATTENDANCE" } });
        inserted();
        await gate;
      },
      { timeout: 20_000 }
    );
    await pollInserted;
    const answering = answerPersonal(token, "PLAYING");
    await new Promise((r) => setTimeout(r, 300));
    release();
    await posting;
    expect(await answering).toEqual({ ok: false, reason: "telegram" });
    expect(await row("mw", "p2")).toBeNull();
  });

  it("organizer override still works on a Telegram match", async () => {
    await telegramMatch("mt");
    signIn("owner");
    expect((await call(overrideRoute.POST(json("POST", { playerId: "p1", status: "NOT_PLAYING" }), gm("mt")))).status).toBe(200);
    expect(await row("mt", "p1")).toMatchObject({ overrideStatus: "NOT_PLAYING" });
  });

  it("cross-organization: a player of another organization gets 404; signed out 401", async () => {
    await webMatch("mw");
    signIn("other");
    expect((await own("mw", "PLAYING")).status).toBe(404);
    signIn(null);
    expect((await own("mw", "PLAYING")).status).toBe(401);
    expect(await prisma.attendanceResponse.count()).toBe(0);
    expect(tgCalls).toBe(0);
    expect(otherNetwork).toBe(0);
  });
});

// ------------------------------------------------------------------ group invitations

const sameOrigin = { Origin: "http://itest.local" };
const g = (org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const gr = (requestId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, requestId }) });
async function newLink(org = "o", group = "g", who = "owner") {
  const prev = session;
  signIn(who);
  const r = await call(joinLinksRoute.POST(json("POST", { action: "create" }), g(org, group)));
  session = prev;
  expect(r.status).toBe(200);
  return { id: r.body.id as string, token: String(r.body.path).split("#")[1] };
}
const preview = (token: unknown) => call(joinPreviewRoute.POST(json("POST", { token })));
const request = (token: string, names = { firstName: "Jamie", lastName: "Applicant" }, headers: Record<string, string> = sameOrigin) =>
  call(joinRequestRoute.POST(json("POST", { token, ...names }, headers)));
const decide = (requestId: string, body: unknown, org?: string, group?: string) => call(joinDecisionRoute.POST(json("POST", body), gr(requestId, org, group)));
const NEW_PLAYER = { firstName: "Jamie", lastName: "Applicant", position: "MIDFIELDER", rating: "GOOD", stamina: 3 };
async function applicant(email: string, id: string) {
  await prisma.user.create({ data: { id, email, name: "Jamie Applicant", passwordHash: null, emailVerifiedAt: VERIFIED_AT } });
}

describe("M13A — join links (organizer)", () => {
  it("OWNER/ADMIN create (token shown once, hash stored), list (no tokens), revoke; a new link turns the old one off", async () => {
    const first = await newLink();
    const stored = await prisma.groupJoinLink.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.tokenHash).toBe(hashToken(first.token));
    expect(stored).toMatchObject({ organizationId: "o", groupId: "g", createdByUserId: "u-owner", revokedAt: null });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(30 * 86_400_000);
    const second = await newLink("o", "g", "admin");
    expect((await prisma.groupJoinLink.findUniqueOrThrow({ where: { id: first.id } })).revokedAt).not.toBeNull();
    signIn("owner");
    const list = await call(joinLinksRoute.GET(json("GET"), g()));
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(list.body)).not.toContain(second.token);
    expect((list.body.links as Array<{ id: string; state: string }>).map((l) => [l.id, l.state])).toEqual([
      [second.id, "active"],
      [first.id, "revoked"],
    ]);
    expect(await call(joinLinksRoute.POST(json("POST", { action: "revoke", linkId: second.id }), g()))).toMatchObject({ status: 200 });
    expect((await preview(second.token)).body).toEqual({ state: "revoked" });
  });

  it("MEMBER, another organization's owner, signed-out: no access (404 / 401)", async () => {
    signIn("member");
    expect((await call(joinLinksRoute.POST(json("POST", { action: "create" }), g()))).status).toBe(404);
    expect((await call(joinLinksRoute.GET(json("GET"), g()))).status).toBe(404);
    expect((await call(joinRequestsRoute.GET(json("GET"), g()))).status).toBe(404);
    signIn("other");
    expect((await call(joinLinksRoute.POST(json("POST", { action: "create" }), g()))).status).toBe(404);
    signIn(null);
    expect((await call(joinLinksRoute.GET(json("GET"), g()))).status).toBe(401);
    expect(await prisma.groupJoinLink.count()).toBe(0);
  });
});

describe("M13A — join requests (applicant)", () => {
  it("preview: group name only (never the roster); invalid → 404; expired → no group info", async () => {
    const { token } = await newLink();
    signIn(null);
    const p = await preview(token);
    expect(p).toMatchObject({ status: 200, body: { state: "valid", group: { name: "Wednesday Soccer", organizationName: "Org", sportLabel: "Soccer" }, viewer: null } });
    expect(p.headers.get("Cache-Control")).toBe("no-store");
    expect(p.headers.get("X-Robots-Tag")).toContain("noindex");
    for (const secret of ["Pat", "Sam", "Kim", "p1", "p2", "player@example.test", "owner@example.test"]) expect(JSON.stringify(p.body)).not.toContain(secret);
    expect(await preview("nope")).toMatchObject({ status: 404, body: { state: "invalid" } });
    expect(await preview(generateToken())).toMatchObject({ status: 404, body: { state: "invalid" } });
    await prisma.groupJoinLink.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await preview(token)).body).toEqual({ state: "expired" });
  });

  it("signed out → 401; unverified → 403; cross-site → 403; nothing is created", async () => {
    const { token } = await newLink();
    signIn(null);
    expect((await request(token)).status).toBe(401);
    signIn("unverified");
    expect(await request(token)).toMatchObject({ status: 403, body: { error: "EMAIL_NOT_VERIFIED" } });
    signIn("player");
    expect((await request(token, undefined, {})).status).toBe(403);
    expect(await prisma.groupJoinRequest.count()).toBe(0);
  });

  it("a valid invite files a PENDING request — no membership, no organization access, no attendance", async () => {
    const { token } = await newLink();
    await applicant("jamie@example.test", "u-jamie");
    signIn("jamie");
    const r = await request(token);
    expect(r).toMatchObject({ status: 201, body: { ok: true, request: { status: "PENDING" } } });
    expect(await prisma.player.findFirst({ where: { groupId: "g", userId: "u-jamie" } })).toBeNull();
    expect(await prisma.organizationMembership.findFirst({ where: { userId: "u-jamie" } })).toBeNull();
    expect((await call(playersRoute.GET(json("GET"), g()))).status).toBe(404); // no admin access
    expect(await loadMyGames("u-jamie")).toEqual([]);
    expect((await preview(token)).body).toMatchObject({ viewer: { member: false, request: { status: "PENDING" } } });
    expect(await listMyJoinRequests("u-jamie")).toEqual([expect.objectContaining({ groupName: "Wednesday Soccer", status: "PENDING" })]);
  });

  it("duplicate pending → 409 (also when sent concurrently: exactly one row); already a member → 409", async () => {
    const { token } = await newLink();
    await applicant("jamie@example.test", "u-jamie");
    signIn("jamie");
    const results = await Promise.all([1, 2, 3, 4].map(() => request(token)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await prisma.groupJoinRequest.count({ where: { userId: "u-jamie" } })).toBe(1);
    signIn("player"); // already linked to p1 in this group
    expect(await request(token)).toMatchObject({ status: 409, body: { code: "ALREADY_MEMBER" } });
  });

  it("expired / revoked invites are refused", async () => {
    const { id, token } = await newLink();
    await applicant("jamie@example.test", "u-jamie");
    signIn("jamie");
    await prisma.groupJoinLink.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await request(token)).toMatchObject({ status: 410, body: { code: "INVITE_EXPIRED" } });
    await prisma.groupJoinLink.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date() } });
    expect(await request(token)).toMatchObject({ status: 410, body: { code: "INVITE_REVOKED" } });
    expect(await request(generateToken())).toMatchObject({ status: 404, body: { code: "INVITE_INVALID" } });
    expect(await prisma.groupJoinRequest.count()).toBe(0);
  });

  it("database-backed limits: per user per day, pending per group", async () => {
    const { token } = await newLink();
    await applicant("jamie@example.test", "u-jamie");
    await prisma.groupJoinRequest.createMany({ data: Array.from({ length: JOIN_LIMITS.requestsPerUserPerDay }, () => ({ organizationId: "o", groupId: "gx", userId: "u-jamie", firstName: "J", lastName: "A", status: "CANCELED" as const })) });
    signIn("jamie");
    expect(await request(token)).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    await prisma.groupJoinRequest.deleteMany({});
    const others = Array.from({ length: JOIN_LIMITS.pendingPerGroup }, (_, i) => ({ id: `u-q${i}`, email: `q${i}@example.test`, emailVerifiedAt: VERIFIED_AT }));
    await prisma.user.createMany({ data: others });
    await prisma.groupJoinRequest.createMany({ data: others.map((u) => ({ organizationId: "o", groupId: "g", userId: u.id, firstName: "Q", lastName: "Q" })) });
    expect(await request(token)).toMatchObject({ status: 429, body: { code: "TOO_MANY_PENDING" } });
  });

  it("the applicant cancels their own pending request (not someone else's) and may request again", async () => {
    const { token } = await newLink();
    await applicant("jamie@example.test", "u-jamie");
    signIn("jamie");
    const id = ((await request(token)).body.request as { id: string }).id;
    signIn("player");
    expect((await call(joinCancelRoute.POST(json("POST", { requestId: id }, sameOrigin)))).status).toBe(404);
    signIn("jamie");
    expect((await call(joinCancelRoute.POST(json("POST", { requestId: id }, sameOrigin)))).status).toBe(200);
    expect((await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELED");
    expect((await request(token)).status).toBe(201);
  });
});

describe("M13A — manual approval (organizer)", () => {
  async function pendingFrom(email: string, id: string, token?: string) {
    const t = token ?? (await newLink()).token;
    await applicant(email, id);
    signIn(id.replace(/^u-/, ""));
    const r = await request(t);
    expect(r.status).toBe(201);
    signIn("owner");
    return (r.body.request as { id: string }).id;
  }

  it("organizer list: pending with the applicant's verified email + the group's UNCLAIMED players only", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    const r = await call(joinRequestsRoute.GET(json("GET"), g()));
    expect(r.body.requests).toEqual([expect.objectContaining({ id, firstName: "Jamie", lastName: "Applicant", email: "jamie@example.test", status: "PENDING" })]);
    expect((r.body.availablePlayers as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(["p2", "p3"]); // p1 is claimed; x1 is another org
  });

  it("approve → link an existing UNCLAIMED player: Player.userId set, claim links revoked, decision audited; /me shows the group", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    await prisma.playerClaim.create({ data: { playerId: "p2", groupId: "g", tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 86_400_000) } });
    expect(await decide(id, { action: "approve", playerId: "p2" })).toMatchObject({ status: 200, body: { ok: true, playerId: "p2" } });
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p2" } })).userId).toBe("u-jamie");
    expect(await prisma.playerClaim.count({ where: { playerId: "p2", revokedAt: null } })).toBe(0);
    expect(await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROVED", playerId: "p2", decidedByUserId: "u-owner" });
    expect(await prisma.organizationMembership.findFirst({ where: { userId: "u-jamie" } })).toBeNull();
    const [profile] = await loadMyGames("u-jamie");
    expect(profile).toMatchObject({ playerId: "p2", groupName: "Wednesday Soccer" });
    expect(await decide(id, { action: "reject" })).toMatchObject({ status: 409, body: { code: "NOT_PENDING" } });
  });

  it("approve → create a NEW player (validated as Add player) linked to the applicant; ADMIN may approve", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    signIn("admin");
    expect(await decide(id, { action: "approve", newPlayer: { ...NEW_PLAYER, position: "WIZARD" } })).toMatchObject({ status: 400 });
    expect(await decide(id, { action: "approve", newPlayer: { ...NEW_PLAYER, rating: "SUPERB" } })).toMatchObject({ status: 400 });
    expect(await decide(id, { action: "approve" })).toMatchObject({ status: 400 });
    const r = await decide(id, { action: "approve", newPlayer: NEW_PLAYER });
    expect(r.status).toBe(200);
    expect(await prisma.player.findUniqueOrThrow({ where: { id: r.body.playerId as string } })).toMatchObject({ groupId: "g", userId: "u-jamie", firstName: "Jamie", position: "MIDFIELDER", rating: "GOOD", isActive: true });
  });

  it("reject: recorded with who and when; nothing created or linked; neutral status for the applicant", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    const players = await prisma.player.count();
    expect(await decide(id, { action: "reject" })).toMatchObject({ status: 200 });
    expect(await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "REJECTED", decidedByUserId: "u-owner", playerId: null });
    expect(await prisma.player.count()).toBe(players);
    expect(await listMyJoinRequests("u-jamie")).toEqual([expect.objectContaining({ status: "REJECTED" })]);
  });

  it("refusals: already-claimed player, unknown / foreign player, MEMBER, other organization, other group", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    expect(await decide(id, { action: "approve", playerId: "p1" })).toMatchObject({ status: 409, body: { code: "PLAYER_ALREADY_CLAIMED" } });
    expect(await decide(id, { action: "approve", playerId: "x1" })).toMatchObject({ status: 404, body: { code: "PLAYER_NOT_FOUND" } });
    signIn("member");
    expect((await decide(id, { action: "approve", playerId: "p2" })).status).toBe(404);
    signIn("other");
    expect((await decide(id, { action: "approve", playerId: "p2" }, "o2", "g2")).status).toBe(404); // not their group's request
    expect((await decide(id, { action: "approve", playerId: "p2" })).status).toBe(404); // not their organization
    signIn("owner");
    expect(await decide(id, { action: "approve", playerId: "p2" }, "o", "gx")).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } }); // other group, same org
    expect((await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p2" } })).userId).toBeNull();
  });

  it("concurrency: two organizers approving the same request, and two requests racing for the same player", async () => {
    const a = await pendingFrom("jamie@example.test", "u-jamie");
    const same = await Promise.all([decide(a, { action: "approve", playerId: "p2" }), decide(a, { action: "approve", playerId: "p3" })]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.player.count({ where: { userId: "u-jamie" } })).toBe(1);

    const { token } = await newLink();
    const b = await pendingFrom("alex@example.test", "u-alex", token);
    const c = await pendingFrom("casey@example.test", "u-casey", token);
    const target = same[0].status === 200 ? "p3" : "p2"; // the player still unclaimed
    const race = await Promise.all([decide(b, { action: "approve", playerId: target }), decide(c, { action: "approve", playerId: target })]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(race.find((r) => r.status === 409)!.body.code).toBe("PLAYER_ALREADY_CLAIMED");
    expect((await prisma.player.findUniqueOrThrow({ where: { id: target } })).userId).toMatch(/^u-(alex|casey)$/);
  });

  it("an applicant linked meanwhile (claim link) can't be linked twice: ALREADY_MEMBER", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    await prisma.player.update({ where: { id: "p3" }, data: { userId: "u-jamie" } });
    expect(await decide(id, { action: "approve", playerId: "p2" })).toMatchObject({ status: 409, body: { code: "ALREADY_MEMBER" } });
    expect(await decide(id, { action: "approve", newPlayer: NEW_PLAYER })).toMatchObject({ status: 409, body: { code: "ALREADY_MEMBER" } });
  });

  it("plan limit: a Free organization at its active-player limit can't approve as a NEW player (402) but can link an existing one", async () => {
    await prisma.player.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, groupId: "gf", firstName: `F${i}`, lastName: "Free", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3 })) });
    const { token } = await newLink("of", "gf", "free");
    await applicant("jamie@example.test", "u-jamie");
    signIn("jamie");
    const id = ((await request(token)).body.request as { id: string }).id;
    signIn("free");
    expect(await decide(id, { action: "approve", newPlayer: NEW_PLAYER }, "of", "gf")).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT" } });
    expect((await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    expect((await decide(id, { action: "approve", playerId: "f0" }, "of", "gf")).status).toBe(200);
  });

  it("revoking the link stops NEW requests; requests already filed stay pending and can still be decided", async () => {
    const link = await newLink();
    const id = await pendingFrom("jamie@example.test", "u-jamie", link.token);
    expect((await call(joinLinksRoute.POST(json("POST", { action: "revoke", linkId: link.id }), g()))).status).toBe(200);
    await applicant("alex@example.test", "u-alex");
    signIn("alex");
    expect((await request(link.token)).body.code).toBe("INVITE_REVOKED");
    signIn("owner");
    expect((await prisma.groupJoinRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    expect((await decide(id, { action: "approve", playerId: "p2" })).status).toBe(200);
  });

  it("after approval: website-only RSVP works on /me; Telegram matches stay poll-only (409)", async () => {
    const id = await pendingFrom("jamie@example.test", "u-jamie");
    await decide(id, { action: "approve", playerId: "p2" });
    await webMatch("mw", { date: new Date("2099-06-01") });
    await telegramMatch("mt");
    signIn("jamie");
    expect((await own("mw", "PLAYING")).status).toBe(200);
    expect((await own("mt", "PLAYING")).body).toMatchObject({ code: "TELEGRAM_MATCH" });
    expect((await loadMyGames("u-jamie"))[0].upcoming.map((u) => u.attendanceMode)).toEqual(["web", "telegram"]);
    expect(tgCalls).toBe(0);
  });
});
