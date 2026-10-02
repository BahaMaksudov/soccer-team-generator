/**
 * M9-A — REAL-DATABASE tests: Matches, attendance (precedence, overrides,
 * late answers, web self-service), the Telegram attendance adapter (posting
 * with MessageDelivery idempotency, live webhook sync, explicit sync),
 * self-service Telegram group connection (bind codes + admin check),
 * /poll and /chatid retirement, OWNER/ADMIN send boundary, Generate/Publish
 * for a Match (incl. the same-day limitation) and public privacy.
 *
 * Guarded local TEST database only. Telegram is a programmable stub; any
 * other network call is counted and forbidden.
 */
import { formatTeamsHtml } from "@/lib/telegramFormat";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/secureToken";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as matchRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/route";
import * as overrideRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/route";
import * as closeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/close/route";
import * as syncRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/attendance/sync/route";
import * as pollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/route";
import * as channelsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/route";
import * as channelRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/[ref]/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as tgUsersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";
import * as tgImportRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/import/route";
import * as tgCreatePollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/create-poll/route";
import * as tgChatsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/chats/route";
import * as selfAttendanceRoute from "@/app/api/account/matches/[matchId]/attendance/route";
import * as publicPlayersRoute from "@/app/api/public/[organizationSlug]/[groupSlug]/players/route";
import * as webhookRoute from "@/app/api/telegram/webhook/route";
import * as swapRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/swap/route";
import * as deliveryRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/delivery/route";
import { loadPublicGroupHomeData } from "@/app/g/[organizationSlug]/[groupSlug]/data";
import { assignmentKey } from "@/lib/teamAssignment";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const WEBHOOK_SECRET = "itest-webhook-secret";
const g = (x: typeof A) => ({ params: Promise.resolve(x) });
const gm = (x: typeof A, matchId: string) => ({ params: Promise.resolve({ ...x, matchId }) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---------------------------------------------------------------- Telegram stub
type Call = { method: string; body: Record<string, unknown> };
let tgCalls: Call[] = [];
let otherNetworkCalls = 0;
let sendPollMode: "ok" | "reject" | "ambiguous" = "ok";
let admins: Array<{ status: string; user: { id: number } }> = [];
let pollSeq = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetworkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  const body = JSON.parse(String(init?.body ?? "{}"));
  tgCalls.push({ method, body });
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) }) as unknown as Response;
  if (method === "sendPoll") {
    if (sendPollMode === "reject") return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) } as unknown as Response;
    if (sendPollMode === "ambiguous") throw new TypeError("fetch failed");
    pollSeq++;
    return ok({ message_id: 100 + pollSeq, poll: { id: `tg-poll-${pollSeq}` } });
  }
  if (method === "getChatAdministrators") return ok(admins);
  return ok({ message_id: 1 });
}
const sends = (method: string) => tgCalls.filter((c) => c.method === method);
const lastReply = () => String(sends("sendMessage").at(-1)?.body.text ?? "");
const webhook = (update: unknown) =>
  webhookRoute.POST(
    new Request("http://itest.local/api/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: JSON.stringify(update),
    }) as never
  );
const groupMessage = (text: string, fromId: number, chat = { id: -5001, type: "supergroup", title: "Thursday Hoops" }, extra: Record<string, unknown> = {}) =>
  webhook({ message: { text, chat, from: { id: fromId }, ...extra } });
const vote = (pollId: string, userId: number, options: number[]) => webhook({ poll_answer: { poll_id: pollId, user: { id: userId, first_name: "V" }, option_ids: options } });

// ---------------------------------------------------------------- fixtures
async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
  return u;
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AttendanceResponse","Match","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","MessageDelivery","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  const mk = (email: string) =>
    prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: verified } });
  const [owner, admin, member, ownerB, player] = await Promise.all([
    mk("owner@example.test"),
    mk("admin@example.test"),
    mk("member@example.test"),
    mk("owner-b@example.test"),
    mk("player@example.test"),
  ]);
  await mk("other@example.test");
  await prisma.organization.createMany({ data: [{ id: "org-a-id", name: "Org A", slug: "org-a" }, { id: "org-b-id", name: "Org B", slug: "org-b" }] });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: owner.id, organizationId: "org-a-id", role: "OWNER" },
      { userId: admin.id, organizationId: "org-a-id", role: "ADMIN" },
      { userId: member.id, organizationId: "org-a-id", role: "MEMBER" },
      { userId: ownerB.id, organizationId: "org-b-id", role: "OWNER" },
    ],
  });
  await prisma.group.create({ data: { id: "ga", organizationId: "org-a-id", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC", visibility: "PUBLIC" } });
  await prisma.group.create({ data: { id: "gb", organizationId: "org-b-id", name: "Group B", slug: "group-b", sportKey: "basketball", timezone: "UTC" } });
  const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
  for (let i = 1; i <= 6; i++) {
    await prisma.player.create({ data: { id: `ga-p${i}`, groupId: "ga", firstName: `A${i}`, lastName: "Player", position: i === 1 ? "GOALKEEPER" : "FORWARD", rating: ratings[i % 4], stamina: 3, userId: i === 3 ? player.id : null } });
  }
  await prisma.player.create({ data: { id: "gb-p1", groupId: "gb", firstName: "B1", lastName: "Player", position: "BIG", rating: "GOOD", stamina: 3 } });
  await prisma.telegramChat.create({ data: { chatId: -1001n, title: "Group A chat", groupId: "ga" } });
  await prisma.telegramUserLink.createMany({
    data: [
      { userId: 111n, playerId: "ga-p1", groupId: "ga" },
      { userId: 222n, playerId: "ga-p2", groupId: "ga" },
      { userId: 444n, playerId: "ga-p4", groupId: "ga" },
    ],
  });
}

async function createMatch(body: Record<string, unknown> = { date: "2026-10-12", startTime: "20:00", locationName: "Field 2" }, grp = A) {
  const res = await matchesRoute.POST(json("POST", body), g(grp));
  return { res, data: await res.json() };
}
const view = async (matchId: string, grp = A) => (await matchRoute.GET(json("GET"), gm(grp, matchId))).json();
const chatRef = async () => (await prisma.telegramChat.findFirstOrThrow({ where: { groupId: "ga" } })).id;
const postPoll = async (matchId: string, intent?: string) => pollRoute.POST(json("POST", { chatRef: await chatRef(), ...(intent ? { intent } : {}) }), gm(A, matchId));

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

beforeEach(async () => {
  session = null;
  tgCalls = [];
  sendPollMode = "ok";
  admins = [{ status: "creator", user: { id: 900 } }, { status: "administrator", user: { id: 901 } }];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "tbp_test_bot");
  await seed();
});

afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// =================================================================== schema
describe("migration #18", () => {
  it("adds the M9-A tables/columns; links nullable; poll kind defaults to ATTENDANCE; Match not unique by date", async () => {
    const cols = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>>(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE (table_name, column_name) IN (('TeamGeneration','matchId'),('TelegramPoll','matchId'),('TelegramPoll','kind'),('MessageDelivery','matchId')) ORDER BY 1,2`
    );
    expect(cols.map((c) => [c.table_name, c.column_name, c.is_nullable])).toEqual([
      ["MessageDelivery", "matchId", "YES"],
      ["TeamGeneration", "matchId", "YES"],
      ["TelegramPoll", "kind", "NO"],
      ["TelegramPoll", "matchId", "YES"],
    ]);
    expect(cols.find((c) => c.column_name === "kind")?.column_default).toContain("ATTENDANCE");
    const uniques = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(`SELECT indexdef FROM pg_indexes WHERE tablename='Match' AND indexdef LIKE '%UNIQUE%'`);
    expect(uniques.map((u) => u.indexdef)).toEqual([expect.stringContaining("Match_pkey")]);
    // legacy-style poll row (no matchId/kind given) reads as ATTENDANCE
    await prisma.telegramPoll.create({ data: { pollId: "legacy", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga" } });
    expect(await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "legacy" } })).toMatchObject({ kind: "ATTENDANCE", matchId: null });
  });
});

// =================================================================== matches
describe("Matches", () => {
  it("two matches on the same date; MEMBER may create/edit; list splits upcoming/past", async () => {
    await signInAs("member@example.test");
    const m1 = await createMatch({ date: "2099-05-02", startTime: "10:00" });
    const m2 = await createMatch({ date: "2099-05-02", startTime: "18:00", locationName: "Gym" });
    expect([m1.res.status, m2.res.status]).toEqual([201, 201]);
    expect(m1.data.match.id).not.toBe(m2.data.match.id);
    const edit = await matchRoute.PATCH(json("PATCH", { locationName: "Field 9", status: "COMPLETED" }), gm(A, m1.data.match.id));
    expect(edit.status).toBe(200);
    const list = await (await matchesRoute.GET(json("GET"), g(A))).json();
    expect(list.upcoming.map((m: { id: string }) => m.id)).toEqual([m2.data.match.id]);
    expect(list.past.map((m: { id: string }) => m.id)).toEqual([m1.data.match.id]);
    expect(tgCalls).toEqual([]); // saving never sends
  });

  it("cross-tenant and anonymous access fail safely; validation enforced", async () => {
    await signInAs("owner@example.test");
    const { data } = await createMatch();
    await signInAs("owner-b@example.test");
    expect((await matchRoute.GET(json("GET"), gm(A, data.match.id))).status).toBe(404);
    expect((await matchRoute.GET(json("GET"), gm(B, data.match.id))).status).toBe(404); // own group, foreign match id
    expect((await matchRoute.PATCH(json("PATCH", { locationName: "x" }), gm(B, data.match.id))).status).toBe(404);
    session = null;
    expect((await matchesRoute.GET(json("GET"), g(A))).status).toBe(401);
    await signInAs("owner@example.test");
    expect((await createMatch({ date: "12/10/2026" })).res.status).toBe(400);
    expect((await createMatch({ date: "2026-10-12", startTime: "25:00" })).res.status).toBe(400);
    expect((await createMatch({ date: "2026-10-12", groupId: "gb" })).data.match).toBeDefined();
    expect(await prisma.match.count({ where: { groupId: "gb" } })).toBe(0);
  });
});

// =================================================================== attendance
describe("Attendance", () => {
  it("override is authoritative over later Telegram answers until cleared; late answers flagged; nothing sent", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    await vote(pollId, 111, [2]); // MAYBE
    let v = await view(id);
    expect(v.roster.find((p: { id: string }) => p.id === "ga-p1").attendance).toMatchObject({ status: "MAYBE", source: "TELEGRAM", overridden: false });

    await signInAs("member@example.test"); // MEMBER manages attendance (internal)
    expect((await overrideRoute.POST(json("POST", { playerId: "ga-p1", status: "PLAYING" }), gm(A, id))).status).toBe(200);
    await vote(pollId, 111, [1]); // later Telegram: NOT_PLAYING
    v = await view(id);
    expect(v.roster.find((p: { id: string }) => p.id === "ga-p1").attendance).toMatchObject({ status: "PLAYING", source: "OVERRIDE", overridden: true, participantStatus: "NOT_PLAYING" });
    expect((await overrideRoute.POST(json("POST", { playerId: "ga-p1", status: null }), gm(A, id))).status).toBe(200);
    v = await view(id);
    expect(v.roster.find((p: { id: string }) => p.id === "ga-p1").attendance).toMatchObject({ status: "NOT_PLAYING", source: "TELEGRAM", overridden: false });

    expect((await closeRoute.POST(json("POST", { closed: true }), gm(A, id))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    await vote(pollId, 222, [0]);
    v = await view(id);
    expect(v.match.attendanceClosed).toBe(true);
    expect(v.roster.find((p: { id: string }) => p.id === "ga-p2").attendance).toMatchObject({ status: "PLAYING", late: true });
    expect(sends("sendMessage")).toEqual([]);
  });

  it("claimed player sets only their own attendance from /me; others refused", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    const bId = (await createMatch({ date: "2026-10-12" }, B)).data?.match?.id; // org-a owner cannot create in B
    expect(bId).toBeUndefined();
    await signInAs("player@example.test");
    expect((await selfAttendanceRoute.POST(json("POST", { status: "MAYBE" }), { params: Promise.resolve({ matchId: id }) })).status).toBe(200);
    expect(await prisma.attendanceResponse.findUniqueOrThrow({ where: { matchId_playerId: { matchId: id, playerId: "ga-p3" } } })).toMatchObject({ participantStatus: "MAYBE", participantSource: "WEB" });
    await signInAs("other@example.test"); // verified, claims nobody
    expect((await selfAttendanceRoute.POST(json("POST", { status: "PLAYING" }), { params: Promise.resolve({ matchId: id }) })).status).toBe(404);
    session = null;
    expect((await selfAttendanceRoute.POST(json("POST", { status: "PLAYING" }), { params: Promise.resolve({ matchId: id }) })).status).toBe(401);
    expect(await prisma.attendanceResponse.count()).toBe(1);
  });
});

// =================================================================== Telegram poll adapter
describe("Telegram attendance poll", () => {
  it("OWNER posts once (3 options, Match-linked, delivery SENT); double click is a no-op; MEMBER refused", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    const r1 = await postPoll(id);
    expect(r1.status).toBe(201);
    expect(sends("sendPoll")).toHaveLength(1);
    expect(sends("sendPoll")[0].body).toMatchObject({ chat_id: "-1001", options: ["✅ Playing", "❌ Not playing", "🤔 Maybe"], is_anonymous: false, allows_multiple_answers: false });
    expect(await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).toMatchObject({ kind: "ATTENDANCE", groupId: "ga" });
    expect(await prisma.messageDelivery.findFirstOrThrow({ where: { matchId: id } })).toMatchObject({ eventType: "ATTENDANCE_POLL_POSTED", status: "SENT", channel: "TELEGRAM" });
    const r2 = await postPoll(id);
    expect(await r2.json()).toMatchObject({ state: "already_posted" });
    expect(sends("sendPoll")).toHaveLength(1);
    await signInAs("member@example.test");
    expect((await postPoll(id)).status).toBe(404);
    expect(sends("sendPoll")).toHaveLength(1);
  });

  it("rejection → FAILED and retryable; ambiguous → UNCERTAIN and never retried blindly; changed match needs post_updated; core data intact", async () => {
    await signInAs("admin@example.test");
    const id = (await createMatch()).data.match.id;
    await overrideRoute.POST(json("POST", { playerId: "ga-p5", status: "PLAYING" }), gm(A, id));
    sendPollMode = "reject";
    expect((await postPoll(id)).status).toBe(502);
    expect((await prisma.messageDelivery.findFirstOrThrow({ where: { matchId: id } })).status).toBe("FAILED");
    sendPollMode = "ok";
    expect((await postPoll(id)).status).toBe(201);

    const id2 = (await createMatch({ date: "2026-10-19" })).data.match.id;
    sendPollMode = "ambiguous";
    expect((await postPoll(id2)).status).toBe(502);
    expect((await prisma.messageDelivery.findFirstOrThrow({ where: { matchId: id2 } })).status).toBe("UNCERTAIN");
    sendPollMode = "ok";
    const before = sends("sendPoll").length;
    expect((await postPoll(id2)).status).toBe(409);
    expect(sends("sendPoll").length).toBe(before);
    expect((await postPoll(id2, "retry_uncertain")).status).toBe(201);

    await matchRoute.PATCH(json("PATCH", { startTime: "21:00" }), gm(A, id));
    const changed = await postPoll(id);
    expect(changed.status).toBe(409);
    expect((await changed.json()).state).toBe("updated_available");
    expect((await postPoll(id, "post_updated")).status).toBe(201);
    // Failures never touched the Match or attendance.
    expect(await prisma.match.count()).toBe(2);
    expect(await prisma.attendanceResponse.findFirstOrThrow({ where: { matchId: id, playerId: "ga-p5" } })).toMatchObject({ overrideStatus: "PLAYING" });
  });

  it("live sync: linked voters update attendance (incl. Maybe and retraction); unlinked voters stay provider-only and appear as a count", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    await vote(pollId, 111, [0]);
    await vote(pollId, 222, [2]);
    await vote(pollId, 444, [0]);
    await vote(pollId, 444, []); // retracted
    await vote(pollId, 333, [0]); // unlinked
    const rows = await prisma.attendanceResponse.findMany({ where: { matchId: id }, orderBy: { playerId: "asc" }, select: { playerId: true, participantStatus: true, participantSource: true } });
    expect(rows).toEqual([
      { playerId: "ga-p1", participantStatus: "PLAYING", participantSource: "TELEGRAM" },
      { playerId: "ga-p2", participantStatus: "MAYBE", participantSource: "TELEGRAM" },
      { playerId: "ga-p4", participantStatus: null, participantSource: "TELEGRAM" },
    ]);
    expect(stringify(await prisma.attendanceResponse.findMany())).not.toMatch(/"333"|"111"/);
    await signInAs("member@example.test");
    const v = await view(id);
    expect(v.telegram.unlinkedVoters).toBe(1);
    expect(v.telegram.poll.pollId).toBeNull(); // provider ids hidden from MEMBER
    expect(stringify(v)).not.toMatch(/333|111|222|-1001/);
    expect(v.counts).toMatchObject({ PLAYING: 1, MAYBE: 1 });
    expect(v.defaultSelection).toEqual(["ga-p1"]); // MAYBE not preselected
  });

  it("explicit sync rebuilds attendance from stored answers with the same mapping, never overwriting a newer web answer", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    await vote(pollId, 111, [0]);
    await vote(pollId, 222, [1]);
    await prisma.attendanceResponse.deleteMany(); // webhook "missed"
    await prisma.attendanceResponse.create({ data: { matchId: id, groupId: "ga", playerId: "ga-p2", participantStatus: "PLAYING", participantSource: "WEB", participantRespondedAt: new Date(Date.now() + 60_000) } });
    await signInAs("member@example.test");
    const res = await syncRoute.POST(json("POST", {}), gm(A, id));
    expect(await res.json()).toMatchObject({ ok: true, recorded: 1, stale: 1, unlinked: 0 });
    const rows = await prisma.attendanceResponse.findMany({ where: { matchId: id }, orderBy: { playerId: "asc" }, select: { playerId: true, participantStatus: true, participantSource: true } });
    expect(rows).toEqual([
      { playerId: "ga-p1", participantStatus: "PLAYING", participantSource: "TELEGRAM" },
      { playerId: "ga-p2", participantStatus: "PLAYING", participantSource: "WEB" },
    ]);
  });

  it("/poll creates nothing; legacy two-option polls still import", async () => {
    await groupMessage("/poll", 900, { id: -1001, type: "supergroup", title: "Group A chat" });
    expect(lastReply()).toBe("Create attendance polls from Team Balance Pro.");
    expect([await prisma.telegramPoll.count(), await prisma.match.count(), await prisma.attendanceResponse.count()]).toEqual([0, 0, 0]);
    await prisma.telegramPoll.create({ data: { pollId: "legacy-2", chatId: -1001n, question: "Q", optionsJson: '["✅ Playing","❌ Not playing"]', groupId: "ga" } });
    await vote("legacy-2", 111, [0]);
    await signInAs("owner@example.test");
    expect(await (await tgImportRoute.POST(json("POST", { pollId: "legacy-2" }), g(A))).json()).toMatchObject({ selectedPlayerIds: ["ga-p1"] });
    expect(await prisma.attendanceResponse.count()).toBe(0); // legacy polls don't write Match attendance
  });
});

// =================================================================== Telegram group connection
describe("Self-service Telegram group connection", () => {
  const issue = async () => (await channelsRoute.POST(json("POST", {}), g(A))).json();

  it("OWNER issues a hash-only code; an administrator binds the group; code is single-use; titles only in the API", async () => {
    await signInAs("owner@example.test");
    const code = await issue();
    expect(code.code).toMatch(/^g_[A-Za-z0-9_-]{22}$/);
    expect(code.deepLink).toBe(`https://t.me/tbp_test_bot?startgroup=${code.code}`);
    expect(code.command).toBe(`/connectgroup@tbp_test_bot ${code.code}`);
    const row = await prisma.telegramChatBindCode.findFirstOrThrow();
    expect(row.codeHash).toBe(hashToken(code.code));
    expect(stringify(await prisma.telegramChatBindCode.findMany())).not.toContain(code.code);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(14 * 60_000);

    await groupMessage(`/start@tbp_test_bot ${code.code}`, 901);
    expect(lastReply()).toContain("now connected to Group A");
    expect(sends("getChatAdministrators")[0].body).toEqual({ chat_id: "-5001" });
    expect(await prisma.telegramChat.findUniqueOrThrow({ where: { chatId: -5001n } })).toMatchObject({ groupId: "ga", title: "Thursday Hoops" });
    await groupMessage(`/connectgroup ${code.code}`, 901, { id: -5002, type: "group", title: "Other" });
    expect(lastReply()).toContain("invalid or has expired");
    expect(await prisma.telegramChat.findUnique({ where: { chatId: -5002n } })).toBeNull();
    const list = await (await channelsRoute.GET(json("GET"), g(A))).json();
    expect(list.telegram.map((c: { title: string }) => c.title)).toEqual(["Group A chat", "Thursday Hoops"]);
    expect(stringify(list)).not.toMatch(/-5001|-1001|chatId/);
  });

  it("non-admin, anonymous admin, private chat and expired codes are refused; nothing bound", async () => {
    await signInAs("admin@example.test");
    const c1 = await issue();
    await groupMessage(`/connectgroup ${c1.code}`, 777); // not an administrator
    expect(lastReply()).toContain("Only an administrator");
    await groupMessage(`/connectgroup ${c1.code}`, 1087968824, undefined, { sender_chat: { id: -5001 } });
    expect(lastReply()).toContain("not anonymously");
    await groupMessage(`/start ${c1.code}`, 900, { id: 900, type: "private", title: "" });
    expect(lastReply()).toContain("only inside a Telegram group");
    await prisma.telegramChatBindCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await groupMessage(`/connectgroup ${c1.code}`, 900);
    expect(lastReply()).toContain("invalid or has expired");
    expect(await prisma.telegramChat.count()).toBe(1);
  });

  it("a chat bound to another Group is refused without revealing it; same group is idempotent; disconnect/reconnect keep history", async () => {
    await signInAs("owner-b@example.test");
    const b = await (await channelsRoute.POST(json("POST", {}), g(B))).json();
    await groupMessage(`/connectgroup ${b.code}`, 900, { id: -1001, type: "supergroup", title: "Group A chat" });
    expect(lastReply()).toBe("❌ This Telegram group is already connected to another Team Balance Pro group. Disconnect it there before connecting it here.");
    expect(lastReply()).not.toMatch(/Group A|org-a/);
    expect((await prisma.telegramChat.findUniqueOrThrow({ where: { chatId: -1001n } })).groupId).toBe("ga");
    expect((await prisma.telegramChatBindCode.findFirstOrThrow({ where: { groupId: "gb" } })).usedAt).toBeNull();

    await signInAs("owner@example.test");
    const a = await issue();
    await groupMessage(`/connectgroup@tbp_test_bot ${a.code}`, 900, { id: -1001, type: "supergroup", title: "Renamed A" });
    expect(lastReply()).toContain("already connected to Group A");
    await prisma.telegramPoll.create({ data: { pollId: "hist", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga" } });
    const ref = await chatRef();
    expect((await channelRoute.DELETE(json("DELETE"), { params: Promise.resolve({ ...A, ref: String(ref) }) })).status).toBe(200);
    expect(await prisma.telegramChat.count({ where: { groupId: "ga" } })).toBe(0);
    expect(await prisma.telegramPoll.count({ where: { pollId: "hist" } })).toBe(1);
    expect(await prisma.telegramUserLink.count({ where: { groupId: "ga" } })).toBe(3);

    await signInAs("owner-b@example.test"); // now free → Group B may connect it with a fresh code
    const b2 = await (await channelsRoute.POST(json("POST", {}), g(B))).json();
    await groupMessage(`/connectgroup ${b2.code}`, 901, { id: -1001, type: "supergroup", title: "Now B" });
    expect((await prisma.telegramChat.findUniqueOrThrow({ where: { chatId: -1001n } })).groupId).toBe("gb");
  });

  it("MEMBER cannot see, connect or disconnect channels; supergroup migration keeps the binding; /chatid reveals nothing", async () => {
    await signInAs("member@example.test");
    expect((await channelsRoute.GET(json("GET"), g(A))).status).toBe(404);
    expect((await channelsRoute.POST(json("POST", {}), g(A))).status).toBe(404);
    expect((await channelRoute.DELETE(json("DELETE"), { params: Promise.resolve({ ...A, ref: String(await chatRef()) }) })).status).toBe(404);
    expect(await prisma.telegramChatBindCode.count()).toBe(0);
    await webhook({ message: { chat: { id: -1001, type: "group" }, from: { id: 900 }, migrate_to_chat_id: -1009 } });
    expect((await prisma.telegramChat.findFirstOrThrow({ where: { groupId: "ga" } })).chatId).toBe(-1009n);
    await groupMessage("/chatid", 900, { id: -1009, type: "supergroup", title: "A" });
    expect(lastReply()).not.toContain("1009");
  });
});

// =================================================================== permissions & privacy
describe("OWNER/ADMIN send boundary and MEMBER privacy", () => {
  it("MEMBER gets 404 from every legacy Telegram endpoint (identity, polls, posting); nothing is sent", async () => {
    await prisma.telegramPollAnswer.create({ data: { pollId: (await prisma.telegramPoll.create({ data: { pollId: "p-x", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga" } })).pollId, userId: 333n, optionIdsJson: "[0]", groupId: "ga", username: "secret_user" } });
    await signInAs("member@example.test");
    for (const res of [
      await tgUsersRoute.GET(json("GET"), g(A)),
      await tgChatsRoute.GET(json("GET"), g(A)),
      await tgImportRoute.POST(json("POST", { pollId: "p-x" }), g(A)),
      await tgCreatePollRoute.POST(json("POST", { chatId: "-1001", pollDate: "2026-10-12" }), g(A)),
      await closePostRoute.POST(json("POST", { pollId: "p-x", teamGenerationId: "x" }), g(A)),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/secret_user|333/);
    }
    expect(tgCalls).toEqual([]);
    await signInAs("admin@example.test");
    expect((await tgUsersRoute.GET(json("GET"), g(A))).status).toBe(200);
  });

  it("public players API exposes no internal Player ids", async () => {
    const body = await (await publicPlayersRoute.GET(json("GET"), g(A))).json();
    expect(body).toHaveLength(6);
    for (const p of body) expect(Object.keys(p).sort()).toEqual(["firstName", "isActive", "lastName", "position"]);
    expect(stringify(body)).not.toMatch(/ga-p\d/);
  });
});

// =================================================================== generate / publish / post from a Match
describe("Generate, publish and post for a Match", () => {
  it("PLAYING preselected → Generate (analysis) → Publish links the generation → Post Teams is separate and OWNER/ADMIN", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date: "2026-10-12" })).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    for (const pid of ["ga-p1", "ga-p2", "ga-p5", "ga-p6"]) await overrideRoute.POST(json("POST", { playerId: pid, status: "PLAYING" }), gm(A, id));
    await overrideRoute.POST(json("POST", { playerId: "ga-p4", status: "MAYBE" }), gm(A, id));
    await signInAs("member@example.test");
    const v = await view(id);
    expect(v.defaultSelection).toEqual(["ga-p1", "ga-p2", "ga-p5", "ga-p6"]);
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: v.defaultSelection }), g(A))).json();
    expect(gen.analysis).toBeDefined();
    const pub = await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: id }), g(A));
    expect(pub.status).toBe(200);
    const genRow = await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "ga" } });
    expect(genRow.matchId).toBe(id);
    expect(sends("sendMessage")).toEqual([]); // Publish != Send
    expect((await closePostRoute.POST(json("POST", { pollId, teamGenerationId: genRow.id }), g(A))).status).toBe(404); // MEMBER cannot post
    await signInAs("owner@example.test");
    expect((await closePostRoute.POST(json("POST", { pollId, teamGenerationId: genRow.id }), g(A))).status).toBe(200);
    expect(await prisma.messageDelivery.findFirstOrThrow({ where: { eventType: "TEAMS_PUBLISHED" } })).toMatchObject({ matchId: id, status: "SENT" });
  });

  it("same-day second Match cannot take over the first Match's saved teams (known transitional limitation); legacy by-date publish still works", async () => {
    await signInAs("owner@example.test");
    const m1 = (await createMatch({ date: "2026-10-12", startTime: "10:00" })).data.match.id;
    const m2 = (await createMatch({ date: "2026-10-12", startTime: "18:00" })).data.match.id;
    const ids = ["ga-p1", "ga-p2", "ga-p3", "ga-p4"];
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(A))).json();
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: m1 }), g(A))).status).toBe(200);
    const conflict = await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: m2 }), g(A));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("SAME_DAY_MATCH_TEAMS");
    expect((await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "ga" } })).matchId).toBe(m1);
    expect((await publishRoute.POST(json("POST", { date: "2026-10-13T00:00:00.000Z", teams: gen.teams, matchId: m1 }), g(A))).status).toBe(400); // wrong date
    expect((await publishRoute.POST(json("POST", { date: "2026-10-20T00:00:00.000Z", teams: gen.teams }), g(A))).status).toBe(200); // legacy
    expect(await prisma.teamGeneration.count({ where: { matchId: null } })).toBe(1);
    await signInAs("owner-b@example.test");
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: [{ teamNumber: 1, players: [{ id: "gb-p1" }] }], matchId: m1 }), g(B))).status).toBe(404); // foreign match
  });
});

describe("default selection follows every attendance change (manual-smoke regression)", () => {
  it("override, clear-revealing-PLAYING, Telegram and web PLAYING all appear in defaultSelection after refresh", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    await overrideRoute.POST(json("POST", { playerId: "ga-p5", status: "PLAYING" }), gm(A, id));
    await vote(pollId, 111, [0]);
    expect((await view(id)).defaultSelection).toEqual(["ga-p1", "ga-p5"]);
    for (const pid of ["ga-p2", "ga-p6"]) await overrideRoute.POST(json("POST", { playerId: pid, status: "PLAYING" }), gm(A, id));
    expect((await view(id)).defaultSelection).toEqual(["ga-p1", "ga-p2", "ga-p5", "ga-p6"]);
    await overrideRoute.POST(json("POST", { playerId: "ga-p5", status: "MAYBE" }), gm(A, id));
    await vote(pollId, 444, [0]); // ga-p4 PLAYING via Telegram
    await overrideRoute.POST(json("POST", { playerId: "ga-p4", status: "NOT_PLAYING" }), gm(A, id));
    expect((await view(id)).defaultSelection).toEqual(["ga-p1", "ga-p2", "ga-p6"]);
    await overrideRoute.POST(json("POST", { playerId: "ga-p4", status: null }), gm(A, id)); // reveals Telegram PLAYING
    await signInAs("player@example.test");
    await selfAttendanceRoute.POST(json("POST", { status: "PLAYING" }), { params: Promise.resolve({ matchId: id }) }); // ga-p3 via web
    await signInAs("owner@example.test");
    expect((await view(id)).defaultSelection).toEqual(["ga-p1", "ga-p2", "ga-p3", "ga-p4", "ga-p6"]);
  });
});

describe("published teams vs working preview (manual-smoke regression)", () => {
  type T = { teamNumber: number; players: Array<{ id: string }> };
  const publicTeams = async () => {
    const home = await loadPublicGroupHomeData(A);
    const latest = home!.items[0] as unknown as { teams: Array<{ teamNumber: number; players: Array<{ firstName: string; lastName: string }> }> };
    return JSON.stringify(latest.teams.map((t) => [t.teamNumber, t.players.map((p) => `${p.firstName} ${p.lastName}`).sort()]).sort());
  };
  const namesOf = (teams: T[]) =>
    JSON.stringify(teams.map((t) => [t.teamNumber, t.players.map((p) => (p as unknown as { firstName: string; lastName: string })).map((p) => `${p.firstName} ${p.lastName}`).sort()]).sort());

  it("publish A → regenerate B (+ swap) keeps A published and public; publish B replaces it; nothing is sent; reload shows the published teams", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date: "2026-10-12" })).data.match.id;
    await postPoll(id);
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    const deliveriesBefore = await prisma.messageDelivery.count();
    const sendsBefore = sends("sendMessage").length;
    const ids = ["ga-p1", "ga-p2", "ga-p3", "ga-p4", "ga-p5", "ga-p6"];
    const gen = async () => (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(A))).json();

    const a = await gen();
    expect((await publishRoute.POST(json("POST", { date: a.date, teams: a.teams, matchId: id }), g(A))).status).toBe(200);
    const genRow = await prisma.teamGeneration.findFirstOrThrow({ where: { matchId: id } });
    const publishedA = { teamsJson: genRow.teamsJson, updatedAt: genRow.updatedAt.getTime() };
    expect(await publicTeams()).toBe(namesOf(a.teams));

    // Reload: the Match view returns the published teams (A), so they are recognized as published.
    expect(assignmentKey((await view(id)).generation.teams)).toBe(assignmentKey(a.teams));

    // Regenerate until we get a different assignment B (preview only).
    let b = await gen();
    for (let i = 0; i < 30 && assignmentKey(b.teams) === assignmentKey(a.teams); i++) b = await gen();
    expect(assignmentKey(b.teams)).not.toBe(assignmentKey(a.teams));
    if (b.analysis?.bestSwap) {
      const swapped = await swapRoute.POST(json("POST", { teams: b.teams.map((t: T) => ({ teamNumber: t.teamNumber, playerIds: t.players.map((p) => p.id) })), swap: { playerA: b.analysis.bestSwap.playerA, playerB: b.analysis.bestSwap.playerB } }), g(A));
      expect(swapped.status).toBe(200);
      b = { ...b, teams: (await swapped.json()).teams };
    }
    // Generate/Regenerate/Apply Swap wrote nothing: A is still the published row and still public.
    const still = await prisma.teamGeneration.findFirstOrThrow({ where: { matchId: id } });
    expect({ teamsJson: still.teamsJson, updatedAt: still.updatedAt.getTime() }).toEqual(publishedA);
    expect(await prisma.teamGeneration.count()).toBe(1);
    expect(await publicTeams()).toBe(namesOf(a.teams));

    // Telegram label state comes from durable delivery records.
    const status = async () => (await (await deliveryRoute.GET(new Request(`http://itest.local/?pollId=${pollId}&teamGenerationId=${genRow.id}`), g(A))).json()).state;
    expect(await status()).toBe("not_posted");
    // Explicit post while preview B is still open: it sends the canonical published A, never the preview.
    expect((await closePostRoute.POST(json("POST", { pollId, teamGenerationId: genRow.id }), g(A))).status).toBe(200);
    const team1Block = (teams: unknown) => {
      const html = formatTeamsHtml("x", teams as never);
      return html.slice(html.indexOf("Team #1"), html.indexOf("Team #2"));
    };
    const postedText = String(sends("sendMessage").at(-1)?.body.text ?? "");
    expect(postedText).toContain(team1Block(JSON.parse(publishedA.teamsJson)));
    expect(team1Block(b.teams)).not.toBe(team1Block(a.teams));
    expect(postedText).not.toContain(team1Block(b.teams));
    expect(await status()).toBe("posted");

    // Publish B → replaces A (same row, no duplicate); public shows B; still nothing sent automatically.
    const sendsAfterPostA = sends("sendMessage").length;
    expect((await publishRoute.POST(json("POST", { date: b.date, teams: b.teams, matchId: id }), g(A))).status).toBe(200);
    expect(await prisma.teamGeneration.count()).toBe(1);
    const rowB = await prisma.teamGeneration.findFirstOrThrow({ where: { matchId: id } });
    expect(rowB.id).toBe(genRow.id);
    expect(JSON.parse(rowB.metricsJson!).analysis.analysisVersion).toBe("balance-analysis-v1");
    expect(await publicTeams()).toBe(namesOf(b.teams));
    expect(assignmentKey((await view(id)).generation.teams)).toBe(assignmentKey(b.teams));
    expect(sends("sendMessage").length).toBe(sendsAfterPostA);
    expect(await status()).toBe("updated_available"); // → "Post Updated Teams to Telegram"
    expect(await prisma.messageDelivery.count()).toBe(deliveriesBefore + 1); // only the explicit post
    expect(sendsAfterPostA - sendsBefore).toBe(1);
  });
});

describe("network safety", () => {
  it("no non-Telegram network call happened", () => {
    expect(otherNetworkCalls).toBe(0);
  });
});
