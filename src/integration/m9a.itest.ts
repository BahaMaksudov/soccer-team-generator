/**
 * M9-A — REAL-DATABASE tests: Matches, attendance (precedence, overrides,
 * late answers, web self-service), the Telegram attendance adapter (posting
 * with MessageDelivery idempotency, live webhook sync, explicit sync),
 * self-service Telegram group connection (bind codes + admin check),
 * /poll and /chatid retirement, OWNER/ADMIN send boundary, Generate/Publish
 * for a Match and public privacy.
 *
 * M9-B (appended below): Match-identified TeamGeneration (same-day Matches),
 * Telegram chat ↔ Player default scope, Match chat selection, linked-voter
 * suggestions, soft disconnect/reconnect, bot removal and bind-code hardening.
 *
 * M9-C (appended below): player-facing Match page access (PUBLIC / LINK via
 * share link / PRIVATE via membership or claim), allow-listed DTO, published
 * teams only, same-day isolation and match-specific Telegram links.
 *
 * M9-D (appended below): result save/publish/post, MVP voting via Telegram
 * (eligibility, self-votes, changes, withdrawals, ties), AI recap with a
 * FAKE provider (privacy, failures, fallback), SAVE ≠ PUBLISH ≠ SEND.
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
import * as chatScopeRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/[ref]/players/route";
import * as matchChatRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/telegram-chat/route";
import * as shareMatchRoute from "@/app/api/share/match/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";
import { loadMatchForViewer } from "@/lib/matchPage";
import { generateToken } from "@/lib/secureToken";
import { generateRecapDraft, syncedRecapText, AI_DRAFT_READY_MESSAGE, summaryReadiness } from "@/lib/postGameUi";
import { legacyResultHash } from "@/lib/messaging/postGameMessages";
import { getMatchSummaryReadiness, runPostGameAction } from "@/lib/postGame";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";

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
// M9-D — programmable sendMessage outcome and a FAKE OpenAI endpoint (never the real one).
let sendMessageMode: "ok" | "reject" | "ambiguous" = "ok";
let aiMode: "ok" | "timeout" | "429" | "500" | "empty" | "incomplete" = "ok";
let aiText = "";
let aiRequests: Array<Record<string, unknown>> = [];
let admins: Array<{ status: string; user: { id: number } }> = [];
let pollSeq = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.startsWith("https://ai.itest/")) {
    aiRequests.push(JSON.parse(String(init?.body ?? "{}")));
    if (aiMode === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (aiMode === "429" || aiMode === "500") return { ok: false, status: Number(aiMode), json: async () => ({}) } as unknown as Response;
    if (!u.endsWith("/responses")) throw new Error("only the Responses API is expected");
    if (aiMode === "incomplete") return { ok: true, status: 200, json: async () => ({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }) } as unknown as Response;
    const text = aiMode === "empty" ? "" : aiText;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }),
    } as unknown as Response;
  }
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
  if (method === "sendMessage" && sendMessageMode === "reject") return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: "Bad Request" }) } as unknown as Response;
  if (method === "sendMessage" && sendMessageMode === "ambiguous") throw new TypeError("fetch failed");
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
  sendMessageMode = "ok";
  aiMode = "ok";
  aiText = "";
  aiRequests = [];
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
  it("two matches on the same date; UI-4A: ADMIN creates/edits, MEMBER may only list; list splits upcoming/past", async () => {
    await signInAs("member@example.test");
    expect((await createMatch({ date: "2099-05-02" })).res.status).toBe(404); // organizer mutation
    expect(await prisma.match.count()).toBe(0);
    await signInAs("admin@example.test");
    const m1 = await createMatch({ date: "2099-05-02", startTime: "10:00" });
    const m2 = await createMatch({ date: "2099-05-02", startTime: "18:00", locationName: "Gym" });
    expect([m1.res.status, m2.res.status]).toEqual([201, 201]);
    expect(m1.data.match.id).not.toBe(m2.data.match.id);
    await signInAs("member@example.test");
    expect((await matchRoute.PATCH(json("PATCH", { locationName: "Nope", status: "CANCELED" }), gm(A, m1.data.match.id))).status).toBe(404);
    await signInAs("admin@example.test");
    const edit = await matchRoute.PATCH(json("PATCH", { locationName: "Field 9", status: "COMPLETED" }), gm(A, m1.data.match.id));
    expect(edit.status).toBe(200);
    await signInAs("member@example.test"); // MEMBER may still view
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

    await signInAs("member@example.test"); // UI-4A — MEMBER cannot manage attendance
    expect((await overrideRoute.POST(json("POST", { playerId: "ga-p1", status: "PLAYING" }), gm(A, id))).status).toBe(404);
    expect((await closeRoute.POST(json("POST", { closed: true }), gm(A, id))).status).toBe(404);
    await signInAs("admin@example.test"); // ADMIN manages attendance (internal)
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
    expect((await syncRoute.POST(json("POST", {}), gm(A, id))).status).toBe(404); // UI-4A — organizer action
    await signInAs("admin@example.test");
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
    expect(await prisma.telegramChat.findFirstOrThrow({ where: { chatId: -5001n } })).toMatchObject({ groupId: "ga", title: "Thursday Hoops" });
    await groupMessage(`/connectgroup ${code.code}`, 901, { id: -5002, type: "group", title: "Other" });
    expect(lastReply()).toContain("invalid or has expired");
    expect(await prisma.telegramChat.findFirst({ where: { chatId: -5002n } })).toBeNull();
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
    expect((await prisma.telegramChat.findFirstOrThrow({ where: { chatId: -1001n } })).groupId).toBe("ga");
    expect((await prisma.telegramChatBindCode.findFirstOrThrow({ where: { groupId: "gb" } })).usedAt).toBeNull();

    await signInAs("owner@example.test");
    const a = await issue();
    await groupMessage(`/connectgroup@tbp_test_bot ${a.code}`, 900, { id: -1001, type: "supergroup", title: "Renamed A" });
    expect(lastReply()).toContain("already connected to Group A");
    await prisma.telegramPoll.create({ data: { pollId: "hist", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga" } });
    const ref = await chatRef();
    expect((await channelRoute.DELETE(json("DELETE"), { params: Promise.resolve({ ...A, ref: String(ref) }) })).status).toBe(200);
    // M9-B — soft disconnect: the row (history) stays, it is just no longer active.
    expect(await prisma.telegramChat.count({ where: { groupId: "ga", disconnectedAt: null } })).toBe(0);
    expect(await prisma.telegramChat.count({ where: { groupId: "ga" } })).toBe(1);
    expect(await prisma.telegramPoll.count({ where: { pollId: "hist" } })).toBe(1);
    expect(await prisma.telegramUserLink.count({ where: { groupId: "ga" } })).toBe(3);

    await signInAs("owner-b@example.test"); // now free → Group B may connect it with a fresh code
    const b2 = await (await channelsRoute.POST(json("POST", {}), g(B))).json();
    await groupMessage(`/connectgroup ${b2.code}`, 901, { id: -1001, type: "supergroup", title: "Now B" });
    // A new row for B; A's disconnected row (and its history) stays with A — nothing moved.
    expect((await prisma.telegramChat.findFirstOrThrow({ where: { chatId: -1001n, disconnectedAt: null } })).groupId).toBe("gb");
    expect(await prisma.telegramChat.count({ where: { chatId: -1001n, groupId: "ga" } })).toBe(1);
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
    const v = await view(id); // MEMBER may view
    expect(v.defaultSelection).toEqual(["ga-p1", "ga-p2", "ga-p5", "ga-p6"]);
    expect((await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: v.defaultSelection }), g(A))).status).toBe(404); // UI-4A
    await signInAs("admin@example.test");
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: v.defaultSelection }), g(A))).json();
    expect(gen.analysis).toBeDefined();
    await signInAs("member@example.test");
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: id }), g(A))).status).toBe(404); // UI-4A
    expect(await prisma.teamGeneration.count()).toBe(0);
    await signInAs("admin@example.test");
    const pub = await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: id }), g(A));
    expect(pub.status).toBe(200);
    await signInAs("member@example.test");
    const genRow = await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "ga" } });
    expect(genRow.matchId).toBe(id);
    expect(sends("sendMessage")).toEqual([]); // Publish != Send
    expect((await closePostRoute.POST(json("POST", { pollId, teamGenerationId: genRow.id }), g(A))).status).toBe(404); // MEMBER cannot post
    await signInAs("owner@example.test");
    expect((await closePostRoute.POST(json("POST", { pollId, teamGenerationId: genRow.id }), g(A))).status).toBe(200);
    expect(await prisma.messageDelivery.findFirstOrThrow({ where: { eventType: "TEAMS_PUBLISHED" } })).toMatchObject({ matchId: id, status: "SENT" });
  });

  it("M9-B: same-day Matches each keep their own teams; a legacy by-date publish never touches a Match's teams", async () => {
    await signInAs("owner@example.test");
    const m1 = (await createMatch({ date: "2026-10-12", startTime: "10:00" })).data.match.id;
    const m2 = (await createMatch({ date: "2026-10-12", startTime: "18:00" })).data.match.id;
    const ids = ["ga-p1", "ga-p2", "ga-p3", "ga-p4"];
    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ids }), g(A))).json();
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: m1 }), g(A))).status).toBe(200);
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: m2 }), g(A))).status).toBe(200);
    const rows = await prisma.teamGeneration.findMany({ where: { groupId: "ga" }, orderBy: { matchId: "asc" } });
    expect(rows.map((r) => r.matchId).sort()).toEqual([m1, m2].sort());
    expect((await publishRoute.POST(json("POST", { date: "2026-10-13T00:00:00.000Z", teams: gen.teams, matchId: m1 }), g(A))).status).toBe(400); // wrong date
    // Legacy publish on the SAME date creates its own row and leaves both Match rows alone.
    const before = JSON.stringify(rows.map((r) => [r.id, r.teamsJson, r.updatedAt.getTime()]));
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams }), g(A))).status).toBe(200);
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams }), g(A))).status).toBe(200); // overwrite, no duplicate
    expect(await prisma.teamGeneration.count({ where: { groupId: "ga", matchId: null } })).toBe(1);
    const after = await prisma.teamGeneration.findMany({ where: { groupId: "ga", matchId: { not: null } }, orderBy: { matchId: "asc" } });
    expect(JSON.stringify(after.map((r) => [r.id, r.teamsJson, r.updatedAt.getTime()]))).toBe(before);
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

// =================================================================== M9-B
const gr = (x: typeof A, ref: number) => ({ params: Promise.resolve({ ...x, ref: String(ref) }) });
const scopeAdd = (ref: number, playerId: string, grp = A, fromSuggestion?: boolean) =>
  chatScopeRoute.POST(json("POST", { playerId, ...(fromSuggestion ? { fromSuggestion } : {}) }), gr(grp, ref));
const scopeRemove = (ref: number, playerId: string, grp = A) => chatScopeRoute.DELETE(json("DELETE", { playerId }), gr(grp, ref));
const selectChat = (matchId: string, ref: number | null, grp = A) => matchChatRoute.POST(json("POST", { chatRef: ref }), gm(grp, matchId));
const teamsOf = (ids: string[][]) => ids.map((players, i) => ({ teamNumber: i + 1, players: players.map((id) => ({ id })) }));
const team1Block = (teamsJson: string) => {
  const html = formatTeamsHtml("x", JSON.parse(teamsJson));
  return html.slice(html.indexOf("Team #1"), html.indexOf("Team #2"));
};

/** Group A: chat A = the seeded "Group A chat"; chat B is a second connected chat of the same Group. */
async function twoChats() {
  const chatA = await chatRef();
  const chatB = (await prisma.telegramChat.create({ data: { chatId: -1002n, title: "Second chat", groupId: "ga" } })).id;
  return { chatA, chatB };
}

describe("M9-B — Match identity: same-day Matches keep separate teams (critical)", () => {
  it("1/13/14: A (18:00) and B (21:00) on 2026-10-10 publish different teams; reload and Telegram posting load each Match's own generation; Publish sends nothing", async () => {
    await signInAs("owner@example.test");
    const a = (await createMatch({ date: "2026-10-10", startTime: "18:00" })).data.match.id;
    const b = (await createMatch({ date: "2026-10-10", startTime: "21:00" })).data.match.id;
    const teamsA = teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]);
    const teamsB = teamsOf([["ga-p1", "ga-p3"], ["ga-p2", "ga-p5"]]);
    const deliveriesBefore = await prisma.messageDelivery.count();
    expect((await publishRoute.POST(json("POST", { date: "2026-10-10", teams: teamsA, matchId: a }), g(A))).status).toBe(200);
    expect((await publishRoute.POST(json("POST", { date: "2026-10-10", teams: teamsB, matchId: b }), g(A))).status).toBe(200);
    expect(sends("sendMessage")).toHaveLength(0); // 14: Publish never sends
    expect(await prisma.messageDelivery.count()).toBe(deliveriesBefore);

    const rows = await prisma.teamGeneration.findMany({ where: { groupId: "ga" } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.date.toISOString()))).toEqual(new Set(["2026-10-10T00:00:00.000Z"]));
    const genA = rows.find((r) => r.matchId === a)!;
    const genB = rows.find((r) => r.matchId === b)!;
    expect(genA.id).not.toBe(genB.id);
    expect(assignmentKey(JSON.parse(genA.teamsJson))).toBe(assignmentKey(teamsA));
    expect(assignmentKey(JSON.parse(genB.teamsJson))).toBe(assignmentKey(teamsB));
    expect(assignmentKey((await view(a)).generation.teams)).toBe(assignmentKey(teamsA)); // reload A → A
    expect(assignmentKey((await view(b)).generation.teams)).toBe(assignmentKey(teamsB)); // reload B → B

    // Republishing A never touches B.
    const teamsA2 = teamsOf([["ga-p1", "ga-p4"], ["ga-p3", "ga-p2"]]);
    expect((await publishRoute.POST(json("POST", { date: "2026-10-10", teams: teamsA2, matchId: a }), g(A))).status).toBe(200);
    const bAfter = await prisma.teamGeneration.findUniqueOrThrow({ where: { id: genB.id } });
    expect([bAfter.teamsJson, bAfter.updatedAt.getTime()]).toEqual([genB.teamsJson, genB.updatedAt.getTime()]);
    expect((await prisma.teamGeneration.findUniqueOrThrow({ where: { id: genA.id } })).matchId).toBe(a); // same row, overwritten

    // 13: each Match's poll posts that Match's generation; a cross-Match post is refused.
    await postPoll(a);
    await postPoll(b);
    const pollA = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: a } })).pollId;
    const pollB = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: b } })).pollId;
    const cross = await closePostRoute.POST(json("POST", { pollId: pollA, teamGenerationId: genB.id }), g(A));
    expect(cross.status).toBe(400);
    expect(sends("sendMessage")).toHaveLength(0);
    expect((await closePostRoute.POST(json("POST", { pollId: pollA, teamGenerationId: genA.id }), g(A))).status).toBe(200);
    const genANow = await prisma.teamGeneration.findUniqueOrThrow({ where: { id: genA.id } });
    expect(String(sends("sendMessage").at(-1)?.body.text)).toContain(team1Block(genANow.teamsJson));
    expect((await closePostRoute.POST(json("POST", { pollId: pollB, teamGenerationId: genB.id }), g(A))).status).toBe(200);
    expect(String(sends("sendMessage").at(-1)?.body.text)).toContain(team1Block(genB.teamsJson));
    expect(String(sends("sendMessage").at(-1)?.body.text)).not.toContain(team1Block(genANow.teamsJson));

    // Legacy by-date uniqueness is intact (one legacy row per Group+date, never a Match's row).
    expect((await publishRoute.POST(json("POST", { date: "2026-10-10", teams: teamsA }), g(A))).status).toBe(200);
    expect((await publishRoute.POST(json("POST", { date: "2026-10-10", teams: teamsB }), g(A))).status).toBe(200);
    expect(await prisma.teamGeneration.count({ where: { groupId: "ga", matchId: null } })).toBe(1);
    expect(await prisma.teamGeneration.count({ where: { groupId: "ga" } })).toBe(3);
  });

  it("schema: partial unique indexes and composite tenant FKs exist (migration #19)", async () => {
    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('TeamGeneration_groupId_date_legacy_key','TelegramChat_chatId_active_key','TelegramChat_chatId_key','TeamGeneration_groupId_date_key') ORDER BY indexname`
    );
    expect(idx.map((i) => i.indexname)).toEqual(["TeamGeneration_groupId_date_legacy_key", "TelegramChat_chatId_active_key"]);
    expect(idx[1].indexdef).toContain(`WHERE ("disconnectedAt" IS NULL)`);
    const fks = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"TelegramChatPlayer"'::regclass AND contype = 'f' ORDER BY conname`
    );
    expect(fks.map((f) => f.conname)).toEqual([
      "TelegramChatPlayer_createdByUserId_fkey",
      "TelegramChatPlayer_groupId_fkey",
      "TelegramChatPlayer_playerId_groupId_fkey",
      "TelegramChatPlayer_telegramChatId_groupId_fkey",
    ]);
  });
});

describe("M9-B — Telegram chat ↔ Player scope", () => {
  it("2: an association is unique per (chat, Player); adding twice is an idempotent no-op", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    expect((await scopeAdd(chatA, "ga-p1")).status).toBe(200);
    expect((await scopeAdd(chatA, "ga-p1")).status).toBe(200);
    expect(await prisma.telegramChatPlayer.count({ where: { telegramChatId: chatA } })).toBe(1);
    await expect(prisma.telegramChatPlayer.create({ data: { groupId: "ga", telegramChatId: chatA, playerId: "ga-p1" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("3: cross-Group associations are impossible (API 404 and database FK)", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    expect((await scopeAdd(chatA, "gb-p1")).status).toBe(404); // another Group's Player
    const chatOfB = (await prisma.telegramChat.create({ data: { chatId: -2001n, title: "B chat", groupId: "gb" } })).id;
    expect((await scopeAdd(chatOfB, "ga-p1")).status).toBe(404); // another Group's chat via A's URL
    expect((await chatScopeRoute.GET(json("GET"), gr(A, chatOfB))).status).toBe(404);
    // The database refuses every mismatched combination, even if the API were bypassed.
    for (const data of [
      { groupId: "ga", telegramChatId: chatA, playerId: "gb-p1" },
      { groupId: "gb", telegramChatId: chatA, playerId: "gb-p1" },
      { groupId: "ga", telegramChatId: chatOfB, playerId: "ga-p1" },
    ]) {
      await expect(prisma.telegramChatPlayer.create({ data })).rejects.toMatchObject({ code: "P2003" });
    }
    expect(await prisma.telegramChatPlayer.count()).toBe(0);
    await signInAs("owner-b@example.test");
    expect((await scopeAdd(chatA, "gb-p1", B)).status).toBe(404);
    const matchA = (await prisma.match.create({ data: { groupId: "ga", date: new Date("2026-10-12T00:00:00Z") } })).id;
    expect((await selectChat(matchA, chatOfB, B)).status).toBe(404); // foreign match
  });

  it("4/5/6/12: Chat A ↔ Chat B scopes; a Player in both; a Player in neither can still play; selection survives reload; nothing is sent", async () => {
    await signInAs("owner@example.test");
    const { chatA, chatB } = await twoChats();
    for (const [ref, pid] of [[chatA, "ga-p1"], [chatB, "ga-p2"], [chatA, "ga-p3"], [chatB, "ga-p3"]] as const) expect((await scopeAdd(ref, pid)).status).toBe(200);
    const id = (await createMatch()).data.match.id;
    expect((await view(id)).scope).toEqual({ chatSelected: false, playerIds: [] });

    expect((await selectChat(id, chatA)).status).toBe(200);
    let v = await view(id); // 12: reload
    expect(v.telegram.selectedChat).toEqual({ ref: chatA, title: "Group A chat", connected: true });
    expect(v.scope.playerIds.sort()).toEqual(["ga-p1", "ga-p3"]);
    expect(v.roster).toHaveLength(6); // the full roster is still there: scope is a default view only

    // 6: Player 4 (no chat) is added to the Match by the organizer and is eligible.
    await overrideRoute.POST(json("POST", { playerId: "ga-p4", status: "PLAYING" }), gm(A, id));
    await overrideRoute.POST(json("POST", { playerId: "ga-p1", status: "PLAYING" }), gm(A, id));
    const before = await prisma.attendanceResponse.findMany({ where: { matchId: id }, orderBy: { playerId: "asc" } });
    expect((await view(id)).defaultSelection).toEqual(["ga-p1", "ga-p4"]);

    expect((await selectChat(id, chatB)).status).toBe(200);
    v = await view(id);
    expect(v.scope.playerIds.sort()).toEqual(["ga-p2", "ga-p3"]);
    expect(v.defaultSelection).toEqual(["ga-p1", "ga-p4"]); // changing the chat changes no attendance
    expect(await prisma.attendanceResponse.findMany({ where: { matchId: id }, orderBy: { playerId: "asc" } })).toEqual(before);

    const gen = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ["ga-p1", "ga-p4", "ga-p5", "ga-p6"] }), g(A))).json();
    expect((await publishRoute.POST(json("POST", { date: gen.date, teams: gen.teams, matchId: id }), g(A))).status).toBe(200);
    expect((await selectChat(id, null)).status).toBe(200);
    expect((await view(id)).scope).toEqual({ chatSelected: false, playerIds: [] });
    expect((await view(id)).generation).not.toBeNull(); // published teams untouched by chat changes
    expect(tgCalls).toHaveLength(0);
    expect(await prisma.messageDelivery.count()).toBe(0);
    expect(await prisma.match.findUniqueOrThrow({ where: { id } })).toMatchObject({ telegramChatId: null });

    // remove works and is scoped
    expect((await scopeRemove(chatB, "ga-p3")).status).toBe(200);
    expect(await prisma.telegramChatPlayer.count({ where: { playerId: "ga-p3" } })).toBe(1);
  });

  it("7/8: a linked voter outside the scope still counts and is SUGGESTED (never auto-added); an unlinked voter creates no Player", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    const id = (await createMatch()).data.match.id;
    await selectChat(id, chatA);
    await pollRoute.POST(json("POST", { chatRef: chatA }), gm(A, id));
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    const players = await prisma.player.count();
    await vote(pollId, 222, [0]); // ga-p2: linked, not in chat A's scope
    await vote(pollId, 999, [0]); // unlinked
    const v = await view(id);
    expect(v.defaultSelection).toEqual(["ga-p2"]);
    expect(v.telegram.suggestedPlayerIds).toEqual(["ga-p2"]);
    expect(v.telegram.unlinkedVoters).toBe(1);
    expect(await prisma.telegramChatPlayer.count()).toBe(1); // not auto-added
    expect(await prisma.player.count()).toBe(players); // no Player invented
    expect(stringify(v)).not.toMatch(/\b999\b|\b222\b/); // no Telegram identity in the view

    expect((await scopeAdd(chatA, "ga-p2", A, true)).status).toBe(200);
    expect(await prisma.telegramChatPlayer.findFirstOrThrow({ where: { playerId: "ga-p2" } })).toMatchObject({ source: "SUGGESTED_VOTE" });
    expect((await view(id)).telegram.suggestedPlayerIds).toEqual([]);
    // A forged "fromSuggestion" for a non-suggested Player is labelled ORGANIZER.
    await scopeAdd(chatA, "ga-p6", A, true);
    expect(await prisma.telegramChatPlayer.findFirstOrThrow({ where: { playerId: "ga-p6" } })).toMatchObject({ source: "ORGANIZER" });
    // The scope endpoint returns Player ids only.
    const scope = await (await chatScopeRoute.GET(json("GET"), gr(A, chatA))).json();
    expect(scope.playerIds.sort()).toEqual(["ga-p1", "ga-p2", "ga-p6"]);
    expect(stringify(scope)).not.toMatch(/-1001|chatId|222|999/);
  });

  it("15: MEMBER cannot read or manage scope or select a chat; MEMBER's view has scope ids but no chat details", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    const id = (await createMatch()).data.match.id;
    await selectChat(id, chatA);
    await signInAs("member@example.test");
    expect((await chatScopeRoute.GET(json("GET"), gr(A, chatA))).status).toBe(404);
    expect((await scopeAdd(chatA, "ga-p2")).status).toBe(404);
    expect((await scopeRemove(chatA, "ga-p1")).status).toBe(404);
    expect((await selectChat(id, null)).status).toBe(404);
    const v = await view(id);
    expect(v.scope).toEqual({ chatSelected: true, playerIds: ["ga-p1"] });
    expect(v.telegram.chats).toEqual([]);
    expect(v.telegram.selectedChat).toBeNull();
    expect(v.telegram.suggestedPlayerIds).toEqual([]);
    expect(await prisma.telegramChatPlayer.count()).toBe(1);
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).telegramChatId).toBe(chatA);
  });
});

describe("M9-B — disconnect / reconnect / bot removal / bind codes", () => {
  const issueA = async () => (await channelsRoute.POST(json("POST", {}), g(A))).json();

  it("9/10: disconnect keeps the row, scope, polls and Match selection; posting is refused; reconnect reactivates the same row", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    const id = (await createMatch()).data.match.id;
    await selectChat(id, chatA);
    await postPoll(id);
    expect((await channelRoute.DELETE(json("DELETE"), gr(A, chatA))).status).toBe(200);
    expect(await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).toMatchObject({ disconnectedAt: expect.any(Date) });
    expect(await prisma.telegramChatPlayer.count({ where: { telegramChatId: chatA } })).toBe(1);
    expect(await prisma.telegramPoll.count({ where: { matchId: id } })).toBe(1);
    const list = await (await channelsRoute.GET(json("GET"), g(A))).json();
    expect(list.telegram.map((c: { ref: number }) => c.ref)).not.toContain(chatA);
    const v = await view(id);
    expect(v.telegram.selectedChat).toEqual({ ref: chatA, title: "Group A chat", connected: false });
    expect(v.scope.playerIds).toEqual(["ga-p1"]);
    const sent = tgCalls.length;
    expect((await pollRoute.POST(json("POST", { chatRef: chatA, intent: "post_updated" }), gm(A, id))).status).toBe(404);
    expect((await selectChat(id, chatA)).status).toBe(404); // cannot newly select a disconnected chat
    expect((await scopeAdd(chatA, "ga-p2")).status).toBe(404);
    expect(tgCalls.length).toBe(sent);

    const code = await issueA();
    await groupMessage(`/connectgroup ${code.code}`, 900, { id: -1001, type: "supergroup", title: "Group A chat (renamed)" });
    expect(lastReply()).toContain("now connected to Group A");
    const row = await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } });
    expect(row).toMatchObject({ disconnectedAt: null, title: "Group A chat (renamed)", groupId: "ga" });
    expect(await prisma.telegramChat.count({ where: { chatId: -1001n } })).toBe(1); // no duplicate binding
    expect(await prisma.telegramChatPlayer.count({ where: { telegramChatId: chatA } })).toBe(1);
    expect((await view(id)).telegram.selectedChat).toMatchObject({ ref: chatA, connected: true });
  });

  it("11: an ACTIVE chat of another Group is never taken over; a chat disconnected from A connects to B as a new row (A keeps its history)", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    await signInAs("owner-b@example.test");
    const b = await (await channelsRoute.POST(json("POST", {}), g(B))).json();
    await groupMessage(`/connectgroup ${b.code}`, 900, { id: -1001, type: "supergroup", title: "x" });
    expect(lastReply()).toContain("already connected to another Team Balance Pro group");
    expect(await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).toMatchObject({ groupId: "ga", disconnectedAt: null, title: "Group A chat" });

    await signInAs("owner@example.test");
    await channelRoute.DELETE(json("DELETE"), gr(A, chatA));
    await signInAs("owner-b@example.test");
    const b2 = await (await channelsRoute.POST(json("POST", {}), g(B))).json();
    await groupMessage(`/connectgroup ${b2.code}`, 900, { id: -1001, type: "supergroup", title: "Now B" });
    const rows = await prisma.telegramChat.findMany({ where: { chatId: -1001n }, orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.groupId, r.disconnectedAt === null])).toEqual([["ga", false], ["gb", true]]);
    expect(await prisma.telegramChatPlayer.findMany({ select: { groupId: true, telegramChatId: true } })).toEqual([{ groupId: "ga", telegramChatId: chatA }]);
    // While B holds it, A cannot reactivate its old row.
    await signInAs("owner@example.test");
    const a = await issueA();
    await groupMessage(`/connectgroup ${a.code}`, 900, { id: -1001, type: "supergroup", title: "Back to A?" });
    expect(lastReply()).toContain("already connected to another Team Balance Pro group");
    expect(await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).toMatchObject({ disconnectedAt: expect.any(Date) });
  });

  it("bot removed (my_chat_member left/kicked) marks the binding disconnected without deleting anything; re-adding the bot does not reconnect", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    const member = (status: string) => webhook({ my_chat_member: { chat: { id: -1001, type: "supergroup" }, from: { id: 900 }, new_chat_member: { status, user: { id: 1 } } } });
    await member("administrator");
    expect((await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).disconnectedAt).toBeNull();
    await member("kicked");
    expect((await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).disconnectedAt).not.toBeNull();
    expect(await prisma.telegramChatPlayer.count()).toBe(1);
    await member("member");
    expect((await prisma.telegramChat.findUniqueOrThrow({ where: { id: chatA } })).disconnectedAt).not.toBeNull();
    // an unknown chat is ignored
    await webhook({ my_chat_member: { chat: { id: -9999, type: "group" }, new_chat_member: { status: "left" } } });
    expect(tgCalls).toHaveLength(0);
  });

  it("a new bind code expires the Group's older unused codes; codes stay hash-only; MEMBER still cannot issue", async () => {
    await signInAs("owner@example.test");
    const first = await issueA();
    const second = await issueA();
    await groupMessage(`/connectgroup ${first.code}`, 900, { id: -7001, type: "group", title: "Old code" });
    expect(lastReply()).toContain("invalid or has expired");
    await groupMessage(`/connectgroup ${second.code}`, 900, { id: -7001, type: "group", title: "New code" });
    expect(lastReply()).toContain("now connected to Group A");
    expect(stringify(await prisma.telegramChatBindCode.findMany())).not.toMatch(new RegExp(`${first.code}|${second.code}`));
    await signInAs("member@example.test");
    expect((await channelsRoute.POST(json("POST", {}), g(A))).status).toBe(404);
  });
});

// =================================================================== M9-C
const BASE = "https://tbp.itest";
const pageView = (matchId: string, grp = A) => loadMatchForViewer({ ...grp, matchId });
const shareView = async (token: unknown, matchId: unknown) => {
  const res = await shareMatchRoute.POST(json("POST", { token, matchId }));
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const setVisibility = (id: string, visibility: "PUBLIC" | "LINK" | "PRIVATE") => prisma.group.update({ where: { id }, data: { visibility } });
async function shareLink(groupId: string) {
  const token = generateToken();
  const row = await prisma.groupShareLink.create({ data: { groupId, tokenHash: hashToken(token) } });
  return { token, id: row.id };
}
async function publishFor(matchId: string, teams: Array<{ teamNumber: number; players: Array<{ id: string }> }>, date = "2026-10-12") {
  expect((await publishRoute.POST(json("POST", { date, teams, matchId }), g(A))).status).toBe(200);
}
/** Anything private that must never reach a player-facing response. */
const FORBIDDEN = /rating|stamina|metrics|analysis|userId|chatId|telegram|email|ga-p\d|"id"|GOOD|EXCELLENT|FAIR|tokenHash|engineVersion/i;

describe("M9-C — PUBLIC Match page", () => {
  it("anonymous viewer sees the exact Match with published names + roles only; never ratings, ids, identity, metrics or a preview", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date: "2026-10-12", startTime: "20:00", locationName: "Field 2" })).data.match.id;
    expect(await pageView(id)).toMatchObject({ teamsPublished: false, teams: [] }); // not published yet
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]));
    // Regenerate B (preview only) — the page keeps A.
    const preview = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: ["ga-p1", "ga-p2", "ga-p5", "ga-p6"] }), g(A))).json();
    session = null;
    const v = await pageView(id);
    expect(v).toEqual({
      group: { name: "Group A", teamName: "", organizationName: "Org A", sportLabel: "Soccer" },
      match: { date: "2026-10-12", startTime: "20:00", locationName: "Field 2", status: "SCHEDULED" },
      teamsPublished: true,
      teams: [
        { teamNumber: 1, players: [{ name: "A1 Player", role: "Goalkeeper" }, { name: "A2 Player", role: "Forward" }] },
        { teamNumber: 2, players: [{ name: "A3 Player", role: "Forward" }, { name: "A4 Player", role: "Forward" }] },
      ],
      // M9-D — nothing post-game is published yet.
      result: null,
      mvp: null,
      recap: null,
    });
    expect(JSON.stringify(v)).not.toMatch(FORBIDDEN);
    // Publish B → the page shows B.
    await signInAs("owner@example.test");
    await publishFor(id, preview.teams.map((t: { teamNumber: number; players: Array<{ id: string }> }) => ({ teamNumber: t.teamNumber, players: t.players.map((p) => ({ id: p.id })) })));
    session = null;
    const names = (await pageView(id))!.teams.flatMap((t) => t.players.map((p) => p.name)).sort();
    expect(names).toEqual(["A1 Player", "A2 Player", "A5 Player", "A6 Player"]);
  });

  it("a Match of another Group, an unknown Match and a canceled Match: safe states", async () => {
    await signInAs("owner-b@example.test");
    const foreign = (await createMatch({ date: "2026-10-12" }, B)).data.match.id;
    await setVisibility("gb", "PUBLIC");
    session = null;
    expect(await pageView(foreign)).toBeNull(); // B's Match under A's slugs
    expect(await pageView("does-not-exist")).toBeNull();
    expect(await pageView(foreign, { organizationSlug: "org-a", groupSlug: "group-b" })).toBeNull();
    expect(await pageView(foreign, B)).toMatchObject({ teamsPublished: false });
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await matchRoute.PATCH(json("PATCH", { status: "CANCELED" }), gm(A, id));
    session = null;
    expect((await pageView(id))!.match.status).toBe("CANCELED");
  });

  it("P4 (outside the selected Telegram chat's scope) appears when published — the page shows the published teams, not chat scope", async () => {
    await signInAs("owner@example.test");
    const { chatA } = await twoChats();
    await scopeAdd(chatA, "ga-p1");
    const id = (await createMatch()).data.match.id;
    await selectChat(id, chatA);
    await publishFor(id, teamsOf([["ga-p1"], ["ga-p4"]]));
    session = null;
    expect((await pageView(id))!.teams.map((t) => t.players.map((p) => p.name))).toEqual([["A1 Player"], ["A4 Player"]]);
  });
});

describe("M9-C — PRIVATE Match page", () => {
  it("anonymous, unrelated, other-Organization and other-Group claimed users are denied; OWNER, ADMIN, MEMBER and the Group's claimed Player are allowed", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1"], ["ga-p2"]]));
    await setVisibility("ga", "PRIVATE");
    const other = await prisma.user.findUniqueOrThrow({ where: { email: "other@example.test" } });

    session = null;
    expect(await pageView(id)).toBeNull();
    await signInAs("other@example.test"); // no membership, no claim
    expect(await pageView(id)).toBeNull();
    await signInAs("owner-b@example.test"); // another Organization
    expect(await pageView(id)).toBeNull();
    await prisma.player.update({ where: { id: "gb-p1" }, data: { userId: other.id } }); // claimed Player of ANOTHER Group
    await signInAs("other@example.test");
    expect(await pageView(id)).toBeNull();

    for (const email of ["owner@example.test", "admin@example.test", "member@example.test", "player@example.test"]) {
      await signInAs(email);
      const v = await pageView(id);
      expect(v, email).not.toBeNull();
      expect(v!.teams).toHaveLength(2);
      expect(JSON.stringify(v)).not.toMatch(FORBIDDEN);
    }
    // A share link never opens a PRIVATE Group.
    const { token } = await shareLink("ga");
    expect((await shareView(token, id)).status).toBe(404);
  });
});

describe("M9-C — LINK Match page (share link)", () => {
  it("valid token → allowed (no-store, noindex); missing/invalid/revoked/foreign token or a Match of another Group → the same 404; bare URL is not public", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1"], ["ga-p2"]]));
    await signInAs("owner-b@example.test");
    const foreign = (await createMatch({ date: "2026-10-12" }, B)).data.match.id;
    await setVisibility("ga", "LINK"); // gb is LINK by default
    const a = await shareLink("ga");
    const b = await shareLink("gb");

    session = null;
    expect(await pageView(id)).toBeNull(); // bare canonical URL, anonymous
    const ok = await shareView(a.token, id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-robots-tag")).toContain("noindex");
    expect(ok.body.teams.map((t: { players: Array<{ name: string }> }) => t.players[0].name)).toEqual(["A1 Player", "A2 Player"]);
    expect(JSON.stringify(ok.body)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(ok.body)).not.toContain(a.token);

    const denied = [
      await shareView(undefined, id),
      await shareView("", id),
      await shareView("not-a-token", id),
      await shareView(generateToken(), id), // well-formed, unknown
      await shareView(b.token, id), // Group B's token for Group A's Match
      await shareView(a.token, foreign), // valid A token, Match of Group B
      await shareView(a.token, undefined),
    ];
    for (const r of denied) expect(r).toMatchObject({ status: 404, body: { error: "This link is not valid." } });
    await prisma.groupShareLink.update({ where: { id: a.id }, data: { revokedAt: new Date() } });
    expect((await shareView(a.token, id)).status).toBe(404); // revoked
    // Signed-in members still use the canonical URL.
    await signInAs("member@example.test");
    expect(await pageView(id)).not.toBeNull();
  });
});

describe("M9-C — Telegram 'View teams online' targets the exact Match", () => {
  const lastText = () => String(sends("sendMessage").at(-1)?.body.text ?? "");

  it("PUBLIC: same-day Matches A/B get their own Match URLs (never the Group page, never by date); legacy teams keep the Group page; the content hash ignores the link", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    await signInAs("owner@example.test");
    const a = (await createMatch({ date: "2026-10-10", startTime: "18:00" })).data.match.id;
    const b = (await createMatch({ date: "2026-10-10", startTime: "21:00" })).data.match.id;
    await publishFor(a, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]), "2026-10-10");
    await publishFor(b, teamsOf([["ga-p1", "ga-p3"], ["ga-p2", "ga-p5"]]), "2026-10-10");
    await postPoll(a);
    await postPoll(b);
    const genA = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: a } });
    const genB = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: b } });
    const pollA = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: a } })).pollId;
    const pollB = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: b } })).pollId;

    expect((await closePostRoute.POST(json("POST", { pollId: pollA, teamGenerationId: genA.id }), g(A))).status).toBe(200);
    expect(lastText()).toContain(`${BASE}/g/org-a/group-a/m/${a}`);
    expect(lastText()).toContain(team1Block(genA.teamsJson));
    expect(lastText()).not.toContain(b);
    expect((await closePostRoute.POST(json("POST", { pollId: pollB, teamGenerationId: genB.id }), g(A))).status).toBe(200);
    expect(lastText()).toContain(`${BASE}/g/org-a/group-a/m/${b}`);
    expect(lastText()).not.toContain(`/m/${a}`);
    expect(lastText()).not.toMatch(new RegExp(`${BASE}/g/org-a/group-a"`)); // not the Group history page

    // Content hash = body WITHOUT the link: the stored hash equals the link-free body's, so the delivery reads "posted".
    const status = async (pollId: string, genId: string) =>
      (await (await deliveryRoute.GET(new Request(`http://itest.local/?pollId=${pollId}&teamGenerationId=${genId}`), g(A))).json()).state;
    expect(await status(pollA, genA.id)).toBe("posted");
    const deliveryA = await prisma.messageDelivery.findFirstOrThrow({ where: { telegramPollId: pollA, eventType: "TEAMS_PUBLISHED" } });
    expect(stringify(deliveryA)).not.toContain(`/m/${a}`); // no URL stored
    // A repeat post of the same teams is a no-op (dedupe unchanged).
    const sent = sends("sendMessage").length;
    expect((await (await closePostRoute.POST(json("POST", { pollId: pollA, teamGenerationId: genA.id }), g(A))).json()).status).toBe("already_posted");
    expect(sends("sendMessage")).toHaveLength(sent);

    // Legacy (no Match) teams still link to the Group page.
    expect((await publishRoute.POST(json("POST", { date: "2026-10-20", teams: teamsOf([["ga-p1"], ["ga-p2"]]) }), g(A))).status).toBe(200);
    const legacy = await prisma.teamGeneration.findFirstOrThrow({ where: { groupId: "ga", matchId: null } });
    await prisma.telegramPoll.create({ data: { pollId: "legacy-poll", chatId: -1001n, question: "Q", optionsJson: "[]", groupId: "ga", pollDate: new Date("2026-10-20T00:00:00Z") } });
    expect((await closePostRoute.POST(json("POST", { pollId: "legacy-poll", teamGenerationId: legacy.id }), g(A))).status).toBe(200);
    expect(lastText()).toContain(`${BASE}/g/org-a/group-a`);
    expect(lastText()).not.toContain("/m/");
  });

  it("LINK: the organizer's current share link becomes /share/m/<matchId>#token; invalid or foreign links are refused; without one there is no link. PRIVATE: no link at all", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    await signInAs("owner@example.test");
    await setVisibility("ga", "LINK");
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1"], ["ga-p2"]]));
    await postPoll(id);
    const gen = await prisma.teamGeneration.findUniqueOrThrow({ where: { matchId: id } });
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id } })).pollId;
    const { token } = await shareLink("ga");
    const foreignToken = (await shareLink("gb")).token;
    const post = (body: Record<string, unknown>) => closePostRoute.POST(json("POST", { pollId, teamGenerationId: gen.id, ...body }), g(A));

    expect((await post({ shareUrl: `${BASE}/share#${foreignToken}` })).status).toBe(400); // another Group's link
    expect((await post({ shareUrl: `https://evil.example/share#${token}` })).status).toBe(400);
    expect(sends("sendMessage")).toHaveLength(0);
    expect((await post({ shareUrl: `${BASE}/share#${token}` })).status).toBe(200);
    expect(lastText()).toContain(`${BASE}/share/m/${id}#${token}`);
    expect(lastText()).not.toContain("/g/org-a");
    // The posted link really opens this Match (and only it).
    session = null;
    expect((await shareView(token, id)).status).toBe(200);
    expect(await prisma.groupShareLink.count({ where: { groupId: "ga" } })).toBe(1); // no credential minted by posting

    // PRIVATE: an updated post carries no URL, and nothing grants anonymous access.
    await signInAs("owner@example.test");
    await setVisibility("ga", "PRIVATE");
    await publishFor(id, teamsOf([["ga-p2"], ["ga-p1"]]));
    expect((await post({ intent: "post_updated", shareUrl: `${BASE}/share#${token}` })).status).toBe(200);
    expect(lastText()).not.toMatch(/https?:\/\//);
    session = null;
    expect(await pageView(id)).toBeNull();
    expect((await shareView(token, id)).status).toBe(404);
  });

  it("the organizer Match view exposes the player page path (no token) and the visibility", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    const v = await view(id);
    expect(v.playerPage).toEqual({ path: `/g/org-a/group-a/m/${id}`, visibility: "PUBLIC" });
  });
});

// =================================================================== M9-D
const pg = (matchId: string, body: Record<string, unknown>, grp = A) => postGameRoute.POST(json("POST", body), gm(grp, matchId));
const pgJson = async (matchId: string, body: Record<string, unknown>, grp = A) => {
  const res = await pg(matchId, body, grp);
  return { status: res.status, body: await res.json() };
};
const postGameOf = async (matchId: string) => (await view(matchId)).postGame;
const msgs = () => sends("sendMessage");
/** A Match with published teams T1 = [p1, p2], T2 = [p3, p4] and the Group A chat selected. */
async function playedMatch(date = "2026-10-12", startTime = "20:00") {
  await signInAs("owner@example.test");
  const id = (await createMatch({ date, startTime })).data.match.id;
  await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]), date);
  await selectChat(id, await chatRef());
  return id;
}
async function startMvp(id: string) {
  await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }] });
  await pg(id, { action: "publish_result" });
  expect((await pg(id, { action: "start_mvp" })).status).toBe(201);
  return (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id, kind: "MVP" } })).pollId;
}
const OPTION = { p1: 0, p2: 1, p3: 2, p4: 3 } as const;

describe("M9-D — result", () => {
  it("1–8: save (draft, hidden, no send) → publish (visible, COMPLETED, no send) → explicit post → edit keeps it published → explicit updated post; validation; UI-4A: MEMBER may neither save nor post", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    const id = await playedMatch();
    for (const bad of [
      [{ teamNumber: 1, score: -1 }, { teamNumber: 2, score: 5 }],
      [{ teamNumber: 1, score: 1.5 }, { teamNumber: 2, score: 5 }],
      [{ teamNumber: 1, score: 7 }, { teamNumber: 3, score: 5 }],
      [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }, { teamNumber: 3, score: 1 }],
      [{ teamNumber: 1, score: 1000 }, { teamNumber: 2, score: 5 }],
    ]) expect((await pg(id, { action: "save_result", scores: bad })).status, JSON.stringify(bad)).toBe(400);

    await signInAs("member@example.test"); // UI-4A — result entry is an organizer mutation
    expect((await pg(id, { action: "save_result", scores: [{ teamNumber: 2, score: 5 }, { teamNumber: 1, score: 7 }] })).status).toBe(404);
    expect(await prisma.matchResult.count()).toBe(0);
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).status).toBe(404); // Telegram is OWNER/ADMIN
    await signInAs("admin@example.test");
    expect((await pg(id, { action: "save_result", scores: [{ teamNumber: 2, score: 5 }, { teamNumber: 1, score: 7 }] })).status).toBe(200);
    session = null;
    expect((await pageView(id))!.result).toBeNull(); // draft is invisible
    await signInAs("owner@example.test");
    expect((await postGameOf(id)).result).toEqual({ scores: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }], published: false });
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.error).toBe("Publish the result before posting the match summary.");

    expect((await pg(id, { action: "publish_result" })).status).toBe(200);
    session = null;
    expect((await pageView(id))!.result).toEqual({ teams: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }], winnerTeamNumber: 1, draw: false });
    expect((await prisma.match.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
    expect(tgCalls).toHaveLength(0); // save + publish sent nothing

    await signInAs("owner@example.test");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    expect(msgs()).toHaveLength(1);
    expect(String(msgs()[0].body.text)).toContain("🏁 MATCH COMPLETE");
    expect(String(msgs()[0].body.text)).toContain("⚽ Team 1  7 — 5  Team 2");
    expect(String(msgs()[0].body.text)).toContain(`${BASE}/g/org-a/group-a/m/${id}`);
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("already_posted"); // dedupe
    expect(msgs()).toHaveLength(1);

    // Correction: stays published, the page shows it, Telegram is NOT updated automatically.
    expect((await pgJson(id, { action: "save_result", scores: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 6 }] })).body.published).toBe(true);
    session = null;
    expect((await pageView(id))!.result!.teams[1].score).toBe(6);
    await signInAs("owner@example.test");
    expect(msgs()).toHaveLength(1);
    expect((await postGameOf(id)).messages.summary).toBe("updated_available");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("updated_available");
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "post_updated" })).body.state).toBe("posted");
    expect(String(msgs()[1].body.text)).toContain("⚽ Team 1  7 — 6  Team 2");
    expect(await prisma.messageDelivery.count({ where: { matchId: id, eventType: "MATCH_SUMMARY_POSTED", status: "SENT" } })).toBe(2);
  });

  it("draw; retry/recovery: a rejected post is FAILED and retryable; an ambiguous one needs an explicit retry", async () => {
    const id = await playedMatch();
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 5 }] });
    await pg(id, { action: "publish_result" });
    session = null;
    expect((await pageView(id))!.result).toMatchObject({ draw: true, winnerTeamNumber: null });
    await signInAs("owner@example.test");
    sendMessageMode = "reject";
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("failed");
    sendMessageMode = "ambiguous";
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("uncertain");
    sendMessageMode = "ok";
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("uncertain"); // never retried blindly
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "retry_uncertain" })).body.state).toBe("posted");
    expect(String(msgs().at(-1)!.body.text)).toContain("🤝 Draw");
  });

  it("9/10: cross-tenant and same-day isolation", async () => {
    const a = await playedMatch("2026-10-10", "18:00");
    const b = await playedMatch("2026-10-10", "21:00");
    await pg(a, { action: "save_result", scores: [{ teamNumber: 1, score: 3 }, { teamNumber: 2, score: 1 }] });
    await pg(b, { action: "save_result", scores: [{ teamNumber: 1, score: 0 }, { teamNumber: 2, score: 2 }] });
    await pg(a, { action: "publish_result" });
    session = null;
    expect((await pageView(a))!.result!.winnerTeamNumber).toBe(1);
    expect((await pageView(b))!.result).toBeNull(); // B still a draft
    await signInAs("owner-b@example.test");
    expect((await pg(a, { action: "publish_result" }, B)).status).toBe(404); // A's Match via B's URL
    expect((await pg(b, { action: "save_result", scores: [{ teamNumber: 1, score: 9 }, { teamNumber: 2, score: 9 }] }, B)).status).toBe(404);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: b } })).scoresJson).toContain('"score":2');
  });
});

describe("M9-D — MVP voting", () => {
  it("11–22, 25: candidates = published participants; eligibility, self-vote, changes, withdrawal, malformed; attendance isolated; close; deterministic winner; publish; no auto announcement", async () => {
    const id = await playedMatch();
    expect((await pgJson(id, { action: "start_mvp" })).body.error).toContain("Publish the final result");
    await prisma.telegramUserLink.createMany({ data: [{ userId: 333n, playerId: "ga-p3", groupId: "ga" }, { userId: 555n, playerId: "ga-p5", groupId: "ga" }] });
    const pollId = await startMvp(id);
    expect(sends("sendPoll")).toHaveLength(1);
    expect(sends("sendPoll")[0].body).toMatchObject({ options: ["A1 Player", "A2 Player", "A3 Player", "A4 Player"], is_anonymous: false, allows_multiple_answers: false });
    expect((await pgJson(id, { action: "start_mvp" })).body.state).toBe("already_posted"); // idempotent
    expect(sends("sendPoll")).toHaveLength(1);
    expect(await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId } })).toMatchObject({ kind: "MVP", matchId: id });

    await vote(pollId, 111, [OPTION.p3]); // p1 → p3 ✓
    await vote(pollId, 222, [OPTION.p2]); // p2 → self ✗
    await vote(pollId, 555, [OPTION.p1]); // p5 not a participant ✗
    await vote(pollId, 999, [OPTION.p1]); // unlinked ✗
    await vote(pollId, 444, [OPTION.p3]); // p4 → p3 ✓
    await vote(pollId, 444, [OPTION.p1]); // p4 changes → p1 (replaces)
    await vote(pollId, 333, [OPTION.p1]); // p3 → p1 ✓
    await vote(pollId, 333, []); // p3 withdraws
    await vote(pollId, 222, [OPTION.p1, OPTION.p3]); // malformed multi-select ✗
    await vote(pollId, 222, [42]); // out of range ✗
    let m = (await postGameOf(id)).mvp;
    expect(m).toMatchObject({ started: true, open: true, validVotes: 2, eligibleVoters: 4 });
    expect(m.candidates.map((c: { votes: number }) => c.votes)).toEqual([1, 0, 1, 0]); // p1:1 (from p4), p3:1 (from p1)
    expect(await prisma.matchMvpVote.count({ where: { matchId: id } })).toBe(2);
    expect(stringify(await view(id))).not.toMatch(/\b(111|222|333|444|555|999)\b/); // no voter identities

    // Attendance answers never become MVP votes, and MVP answers never touch attendance.
    expect(await prisma.attendanceResponse.count({ where: { matchId: id } })).toBe(0);
    await postPoll(id);
    const attendancePoll = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id, kind: "ATTENDANCE" } })).pollId;
    await vote(attendancePoll, 222, [0]);
    expect(await prisma.matchMvpVote.count({ where: { matchId: id } })).toBe(2);
    expect(await prisma.attendanceResponse.count({ where: { matchId: id } })).toBe(1);

    // p2 breaks the tie → p1 leads; close (stopPoll, no message); late answers are ignored.
    await vote(pollId, 222, [OPTION.p1]);
    const before = msgs().length;
    expect((await pgJson(id, { action: "close_mvp" })).body.state).toBe("closed");
    expect(sends("stopPoll")).toHaveLength(1);
    expect(msgs()).toHaveLength(before);
    await vote(pollId, 111, [OPTION.p1]);
    await vote(pollId, 444, []);
    m = (await postGameOf(id)).mvp;
    expect(m).toMatchObject({ closed: true, validVotes: 3, leaders: ["ga-p1"] });

    session = null;
    expect((await pageView(id))!.mvp).toBeNull(); // not published yet
    await signInAs("member@example.test"); // UI-4A — publishing is an organizer mutation
    expect((await pgJson(id, { action: "publish_mvp" })).status).toBe(404);
    await signInAs("admin@example.test");
    expect((await pgJson(id, { action: "publish_mvp" })).body.decision).toBe("VOTES");
    session = null;
    expect((await pageView(id))!.mvp).toEqual({ names: ["A1 Player"], shared: false });
    expect(msgs()).toHaveLength(before); // no automatic announcement

    await signInAs("owner@example.test");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted"); // 26: explicit
    expect(String(msgs().at(-1)!.body.text)).toContain("Player of the Match");
    expect(String(msgs().at(-1)!.body.text)).toContain("A1 Player");
    expect(String(msgs().at(-1)!.body.text)).not.toMatch(/vote[sd]?\s*\d|\d+\s*votes/i);
  });

  it("23: a tie is never resolved silently — co-MVPs or a recorded organizer tie-break; picks must be tied leaders", async () => {
    await prisma.telegramUserLink.create({ data: { userId: 333n, playerId: "ga-p3", groupId: "ga" } });
    const id = await playedMatch();
    const pollId = await startMvp(id);
    await vote(pollId, 111, [OPTION.p3]);
    await vote(pollId, 333, [OPTION.p1]);
    await pg(id, { action: "close_mvp" });
    expect((await postGameOf(id)).mvp.leaders.sort()).toEqual(["ga-p1", "ga-p3"]);
    expect((await pgJson(id, { action: "publish_mvp" })).body).toMatchObject({ code: "TIED" });
    expect((await pgJson(id, { action: "publish_mvp", tieBreak: { mode: "pick", playerId: "ga-p2" } })).status).toBe(400);
    expect((await pgJson(id, { action: "publish_mvp", tieBreak: { mode: "co" } })).body.decision).toBe("CO_MVP");
    session = null;
    expect((await pageView(id))!.mvp).toEqual({ names: ["A1 Player", "A3 Player"], shared: true });
    await signInAs("owner@example.test");
    expect((await pgJson(id, { action: "publish_mvp", tieBreak: { mode: "pick", playerId: "ga-p3" } })).body.decision).toBe("ORGANIZER_TIEBREAK");
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ winnerPlayerIds: ["ga-p3"], decision: "ORGANIZER_TIEBREAK" });
  });

  it("poll option limit: > 10 participants requires an explicit shortlist of participants (nobody silently dropped); 27: cross-tenant/role checks", async () => {
    await signInAs("owner@example.test");
    for (let i = 1; i <= 6; i++) await prisma.player.create({ data: { id: `ga-x${i}`, groupId: "ga", firstName: `X${i}`, lastName: "Player", position: "FORWARD", rating: "GOOD", stamina: 3 } });
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2", "ga-p3", "ga-x1", "ga-x2", "ga-x3"], ["ga-p4", "ga-p5", "ga-p6", "ga-x4", "ga-x5", "ga-x6"]]));
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 1 }, { teamNumber: 2, score: 0 }] });
    await pg(id, { action: "publish_result" });
    expect((await pgJson(id, { action: "start_mvp" })).body.error).toContain("Telegram group"); // no chat selected
    await selectChat(id, await chatRef());
    expect((await pgJson(id, { action: "start_mvp" })).body.code).toBe("SHORTLIST_REQUIRED");
    expect((await pgJson(id, { action: "start_mvp", candidateIds: ["ga-p1", "gb-p1"] })).status).toBe(404); // other Group's Player
    expect(sends("sendPoll")).toHaveLength(0);
    await signInAs("member@example.test");
    expect((await pg(id, { action: "start_mvp", candidateIds: ["ga-p1", "ga-x6"] })).status).toBe(404); // Telegram is OWNER/ADMIN
    await signInAs("owner-b@example.test");
    expect((await pg(id, { action: "start_mvp", candidateIds: ["ga-p1", "ga-x6"] }, B)).status).toBe(404);
    await signInAs("admin@example.test");
    expect((await pg(id, { action: "start_mvp", candidateIds: ["ga-p1", "ga-x6", "ga-p4"] })).status).toBe(201);
    expect(sends("sendPoll")[0].body.options).toEqual(["A1 Player", "X6 Player", "A4 Player"]);
    expect((await pgJson(id, { action: "start_mvp", candidateIds: ["ga-p1", "ga-p2"] })).status).toBe(409); // candidates are fixed
  });
});

describe("M9-D — recap", () => {
  it("28–40: AI not configured → standard fallback; FAKE AI with sanitized facts only; review/save sources; draft hidden; publish; explicit post; edit needs explicit update", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    await prisma.player.update({ where: { id: "ga-p1" }, data: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: "other@example.test" } })).id } });
    const id = await playedMatch();
    expect((await pgJson(id, { action: "generate_recap" })).body.error).toContain("Publish the final result");
    const pollId = await startMvp(id);
    await vote(pollId, 222, [OPTION.p1]);
    await pg(id, { action: "close_mvp" });
    await pg(id, { action: "publish_mvp" });
    const standard = "Team 1 beat Team 2, 7–5. Player of the Match: A1 Player. Thanks to everyone who played!";
    expect((await postGameOf(id)).standardRecap).toBe(standard); // 28

    vi.stubEnv("OPENAI_API_KEY", "");
    const notConfigured = await pgJson(id, { action: "generate_recap" });
    expect(notConfigured).toMatchObject({ status: 503, body: { code: "NOT_CONFIGURED", fallback: standard } });
    expect(aiRequests).toHaveLength(0);

    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    vi.stubEnv("OPENAI_MODEL", "itest-model");
    for (const [mode, code] of [["timeout", "TIMEOUT"], ["429", "RATE_LIMITED"], ["500", "PROVIDER_ERROR"], ["empty", "EMPTY"], ["incomplete", "INCOMPLETE"]] as const) {
      aiMode = mode;
      expect(await pgJson(id, { action: "generate_recap" }), mode).toMatchObject({ status: 503, body: { code, fallback: standard } });
    }
    aiMode = "ok";
    aiText = "<b>What a night!</b> Team 1 won 7–5 and A1 Player was Player of the Match 🏆";
    const gen = await pgJson(id, { action: "generate_recap" });
    expect(gen).toMatchObject({ status: 200, body: { text: "What a night! Team 1 won 7–5 and A1 Player was Player of the Match 🏆" } });
    // 29: the provider got the verified facts only.
    const sent = aiRequests.at(-1)!;
    expect(sent.model).toBe("itest-model");
    expect(sent).toMatchObject({ store: false, reasoning: { effort: "low" }, text: { format: { type: "text" } } });
    expect(sent).not.toHaveProperty("tools");
    const userMsg = sent.input as string;
    expect(JSON.parse(userMsg)).toEqual({ sport: "Soccer", date: "2026-10-12", venue: null, teams: [{ name: "Team 1", score: 7 }, { name: "Team 2", score: 5 }], outcome: { kind: "WIN", winner: "Team 1" }, scoreLine: "7–5", mvp: ["A1 Player"], participants: 4 });
    // The facts payload carries no private data; the whole request carries no ids, emails, Telegram ids or the key.
    expect(userMsg).not.toMatch(/ga-p\d|other@|example\.test|rating|stamina|GOOD|EXCELLENT|FAIR|111|222|userId|telegram/i);
    expect(JSON.stringify(sent)).not.toMatch(/ga-p\d|other@|example\.test|\b111\b|\b222\b|sk-itest|userId/);
    expect((await prisma.matchRecap.findUniqueOrThrow({ where: { matchId: id } })).content).toBeNull(); // generating saves nothing canonical
    expect(tgCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0);

    const text = gen.body.text as string;
    expect((await pgJson(id, { action: "save_recap", content: text })).body.source).toBe("AI");
    expect((await pgJson(id, { action: "save_recap", content: `${text} See you next week!` })).body.source).toBe("AI_EDITED");
    expect((await pgJson(id, { action: "save_recap", content: standard })).body.source).toBe("DETERMINISTIC");
    expect((await pgJson(id, { action: "save_recap", content: "x".repeat(1201) })).status).toBe(400);
    expect((await pgJson(id, { action: "save_recap", content: "   " })).status).toBe(400);
    await pg(id, { action: "save_recap", content: `${text} See you next week!` });
    session = null;
    expect((await pageView(id))!.recap).toBeNull(); // 35: draft hidden
    await signInAs("owner@example.test");
    expect((await pg(id, { action: "publish_recap" })).status).toBe(200);
    session = null;
    const page = (await pageView(id))!;
    expect(page.recap).toEqual({ text: `${text} See you next week!` }); // 37
    expect(JSON.stringify(page)).not.toMatch(/generated|source|AI_EDITED|itest-model|decision|votes|ga-p\d|publishedBy/);
    await signInAs("owner@example.test");
    expect(msgs()).toHaveLength(0); // 38: generate/save/publish sent nothing

    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted"); // 39
    expect(String(msgs().at(-1)!.body.text)).toContain("See you next week!");
    expect(String(msgs().at(-1)!.body.text)).toContain(`/m/${id}`);
    await pg(id, { action: "save_recap", content: "Corrected recap." });
    expect(msgs()).toHaveLength(1);
    expect((await postGameOf(id)).messages.summary).toBe("updated_available"); // 40
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "post_updated" })).body.state).toBe("posted");
    expect(String(msgs().at(-1)!.body.text)).toContain("Corrected recap.");
  });
});

describe("M9-D — no automatic sends, canceled Matches, access modes, same-day", () => {
  it("47: SAVE/PUBLISH/CLOSE/GENERATE never send; only Start MVP (one poll) and explicit posts do", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    aiText = "Fun game, Team 1 won 7–5!";
    await prisma.telegramUserLink.create({ data: { userId: 333n, playerId: "ga-p3", groupId: "ga" } });
    const id = await playedMatch();
    const count = () => ({ messages: sends("sendMessage").length, polls: sends("sendPoll").length });
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }] });
    await pg(id, { action: "publish_result" });
    expect(count()).toEqual({ messages: 0, polls: 0 });
    await pg(id, { action: "start_mvp" });
    expect(count()).toEqual({ messages: 0, polls: 1 });
    const pollId = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: id, kind: "MVP" } })).pollId;
    await vote(pollId, 333, [OPTION.p1]);
    await pg(id, { action: "close_mvp" });
    await pg(id, { action: "publish_mvp" });
    await pg(id, { action: "generate_recap" });
    await pg(id, { action: "save_recap", content: "Fun game, Team 1 won 7–5!" });
    await pg(id, { action: "publish_recap" });
    expect(count()).toEqual({ messages: 0, polls: 1 });
    expect(await prisma.messageDelivery.count({ where: { matchId: id, eventType: { in: ["MATCH_RESULT_POSTED", "MVP_ANNOUNCED", "MATCH_RECAP_POSTED", "MATCH_SUMMARY_POSTED"] } } })).toBe(0);
  });

  it("53/54: a canceled Match cannot record a result, start MVP or generate/save a recap", async () => {
    const id = await playedMatch();
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 1 }, { teamNumber: 2, score: 0 }] });
    await pg(id, { action: "publish_result" });
    await matchRoute.PATCH(json("PATCH", { status: "CANCELED" }), gm(A, id));
    for (const body of [
      { action: "save_result", scores: [{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 0 }] },
      { action: "start_mvp" },
      { action: "generate_recap" },
      { action: "save_recap", content: "We played!" },
    ]) expect((await pgJson(id, body)).body.error, body.action).toContain("canceled");
    expect(tgCalls).toHaveLength(0);
    expect(aiRequests).toHaveLength(0);
  });

  it("44–47: published post-game data follows the M9-C access rules (LINK token, PRIVATE membership) and the allow-list", async () => {
    const id = await playedMatch();
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 1 }] });
    await pg(id, { action: "publish_result" });
    await pg(id, { action: "save_recap", content: "Thanks all!" });
    await pg(id, { action: "publish_recap" });
    await setVisibility("ga", "LINK");
    const { token } = await shareLink("ga");
    session = null;
    expect(await pageView(id)).toBeNull();
    const viaLink = await shareView(token, id);
    expect(viaLink.body).toMatchObject({ result: { winnerTeamNumber: 1 }, recap: { text: "Thanks all!" }, mvp: null });
    expect(JSON.stringify(viaLink.body)).not.toMatch(FORBIDDEN);
    await setVisibility("ga", "PRIVATE");
    expect((await shareView(token, id)).status).toBe(404);
    await signInAs("player@example.test");
    expect((await pageView(id))!.recap).toEqual({ text: "Thanks all!" });
  });

  it("61: same-day Matches keep separate results, MVP votes, recaps, deliveries and pages", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    const a = await playedMatch("2026-10-10", "18:00");
    const b = await playedMatch("2026-10-10", "21:00");
    const pollA = await startMvp(a);
    await pg(b, { action: "save_result", scores: [{ teamNumber: 1, score: 0 }, { teamNumber: 2, score: 4 }] });
    await pg(b, { action: "publish_result" });
    expect((await pg(b, { action: "start_mvp" })).status).toBe(201);
    const pollB = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: b, kind: "MVP" } })).pollId;
    await vote(pollA, 111, [OPTION.p3]);
    await vote(pollB, 111, [OPTION.p4]);
    expect(await prisma.matchMvpVote.findMany({ where: { voterPlayerId: "ga-p1" }, orderBy: { matchId: "asc" }, select: { matchId: true, candidatePlayerId: true } })).toEqual(
      [{ matchId: a, candidatePlayerId: "ga-p3" }, { matchId: b, candidatePlayerId: "ga-p4" }].sort((x, y) => (x.matchId < y.matchId ? -1 : 1))
    );
    await pg(a, { action: "save_recap", content: "Recap A" });
    await pg(b, { action: "save_recap", content: "Recap B" });
    await pg(a, { action: "publish_recap" });
    await pg(b, { action: "publish_recap" });
    await pg(a, { action: "post_message", kind: "summary" });
    expect(String(msgs().at(-1)!.body.text)).toContain(`/m/${a}`);
    await pg(b, { action: "post_message", kind: "summary" });
    expect(String(msgs().at(-1)!.body.text)).toContain(`/m/${b}`);
    expect(String(msgs().at(-1)!.body.text)).toContain("⚽ Team 1  0 — 4  Team 2");
    session = null;
    const [pa, pb] = [(await pageView(a))!, (await pageView(b))!];
    expect([pa.result!.winnerTeamNumber, pb.result!.winnerTeamNumber]).toEqual([1, 2]);
    expect([pa.recap!.text, pb.recap!.text]).toEqual(["Recap A", "Recap B"]);
    expect(await prisma.messageDelivery.count({ where: { matchId: a, eventType: "MATCH_SUMMARY_POSTED" } })).toBe(1);
    expect(await prisma.messageDelivery.count({ where: { matchId: b, eventType: "MATCH_SUMMARY_POSTED" } })).toBe(1);
  });
});

describe("M9-D production-validation fix — AI draft reaches the textarea", () => {
  it("first generation (no recap row yet): route returns the draft → client handler sets it → view reload keeps it; nothing saved/published/sent", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    aiText = "What a game! Team 1 took it 5–3 ⚽";
    const id = await playedMatch();
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    const before = (await postGameOf(id)).recap;
    expect(before).toBeNull();

    // Client state model: textarea text + last server value (exactly what PostGameSection keeps).
    let text = "";
    let lastServer: string | null | undefined = before?.content;
    const messages: Array<string | null> = [];
    const result = await generateRecapDraft({
      request: async (body) => {
        const res = await pg(id, body);
        return { ok: res.ok, data: await res.json() };
      },
      setDraft: (t) => (text = t),
      notify: (m) => messages.push(m),
      setError: () => {},
    });
    expect(result).toBe("draft");
    expect(text).toBe("What a game! Team 1 took it 5–3 ⚽");
    expect(messages.at(-1)).toBe(AI_DRAFT_READY_MESSAGE);

    // Any later reload of the view (e.g. after another action) must not wipe the draft.
    const after = (await postGameOf(id)).recap;
    expect(after).toMatchObject({ content: null, published: false, hasAiDraft: true });
    text = syncedRecapText(text, lastServer, after.content);
    lastServer = after.content;
    expect(text).toBe("What a game! Team 1 took it 5–3 ⚽");

    // Review only: no canonical recap, nothing published, nothing sent; result unchanged; no MVP state.
    const row = await prisma.matchRecap.findUniqueOrThrow({ where: { matchId: id } });
    expect(row).toMatchObject({ content: null, source: null, publishedAt: null });
    expect(tgCalls.filter((c) => c.method === "sendMessage" || c.method === "sendPoll")).toHaveLength(0);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: id } })).scoresJson).toBe(JSON.stringify([{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }]));
    expect(await prisma.matchMvp.count({ where: { matchId: id } })).toBe(0);
    session = null;
    expect((await pageView(id))!.recap).toBeNull();

    // Then the organizer saves it explicitly → source AI; the synced textarea keeps the saved text.
    await signInAs("owner@example.test");
    expect((await pgJson(id, { action: "save_recap", content: text })).body.source).toBe("AI");
    const saved = (await postGameOf(id)).recap.content;
    expect(syncedRecapText(text, lastServer, saved)).toBe("What a game! Team 1 took it 5–3 ⚽");
  });

  it("MVP card data for the production state: result published, no Telegram group selected, nothing started", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]));
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    const p = await postGameOf(id);
    expect(p).toMatchObject({ result: { published: true }, mvp: null, messages: { destinationConnected: false } });
    expect((await pgJson(id, { action: "start_mvp" })).body.error).toBe("Choose a connected Telegram group for this match first.");
    expect((await pgJson(id, { action: "publish_mvp" })).body.error).toBe("Close the MVP vote first."); // no poll-less organizer selection
  });
});

describe("M9-D enhancement — Player of the Match: Organizer Selection (and method locking)", () => {
  /** Published teams T1=[p1,p2], T2=[p3,p4], published result; NO Telegram group selected. */
  async function readyMatch(date = "2026-10-12", startTime = "20:00") {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date, startTime })).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]), date);
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    return id;
  }

  it("1/2/6/7/8/9/11/13: OWNER or ADMIN selects a participant without any Telegram group; save ≠ publish ≠ send; the page shows only the name", async () => {
    const id = await readyMatch();
    expect((await postGameOf(id)).messages.destinationConnected).toBe(false);
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p3" })).body).toEqual({ ok: true, published: false }); // OWNER
    await signInAs("admin@example.test");
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p2" })).status).toBe(200); // ADMIN (changes the saved selection)
    const mvpRow = await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } });
    expect(mvpRow).toMatchObject({ method: "ORGANIZER_SELECTION", selectedPlayerId: "ga-p2", publishedAt: null, winnerPlayerIds: [], decision: null });
    expect(mvpRow.selectedByUserId).toBe((await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.test" } })).id);
    expect(mvpRow.selectedAt).toBeInstanceOf(Date);
    expect((await postGameOf(id)).mvp).toMatchObject({ method: "ORGANIZER_SELECTION", selection: { playerId: "ga-p2", name: "A2 Player", teamNumber: 1 }, published: false });
    session = null;
    expect((await pageView(id))!.mvp).toBeNull(); // saved ≠ published
    await signInAs("admin@example.test");
    expect((await pgJson(id, { action: "publish_mvp" })).body).toMatchObject({ ok: true, method: "ORGANIZER_SELECTION" });
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ winnerPlayerIds: ["ga-p2"], decision: null, publishedAt: expect.any(Date) });
    expect(tgCalls).toHaveLength(0); // select/save/publish sent nothing
    session = null;
    const page = (await pageView(id))!;
    expect(page.mvp).toEqual({ names: ["A2 Player"], shared: false });
    expect(JSON.stringify(page)).not.toMatch(/ORGANIZER|SELECTION|method|selected|admin@|ga-p\d|decision/i);
  });

  it("3/4/5: MEMBER cannot select, reset or publish an organizer selection; non-participants and other Groups' Players are not found", async () => {
    const id = await readyMatch();
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p5" })).status).toBe(404); // in the Group, not in the published teams
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "gb-p1" })).status).toBe(404); // another Group
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "does-not-exist" })).status).toBe(404);
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p1" });
    await signInAs("member@example.test");
    expect((await pg(id, { action: "save_mvp_selection", playerId: "ga-p4" })).status).toBe(404);
    expect((await pg(id, { action: "reset_mvp_selection" })).status).toBe(404);
    expect((await pg(id, { action: "publish_mvp" })).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await pg(id, { action: "save_mvp_selection", playerId: "ga-p4" }, B)).status).toBe(404);
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ selectedPlayerId: "ga-p1", publishedAt: null });
  });

  it("10/12: explicit announcement sends exactly one message; the AI recap receives only the published organizer-selected name", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    aiText = "Team 1 takes it 5–3! Player of the Match honors go to A3 Player 🏆";
    const id = await readyMatch();
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p3" });
    await pg(id, { action: "generate_recap" });
    expect(JSON.parse(aiRequests.at(-1)!.input as string).mvp).toEqual([]); // saved but unpublished → not a fact
    await pg(id, { action: "publish_mvp" });
    expect((await pgJson(id, { action: "generate_recap" })).status).toBe(200);
    expect(JSON.parse(aiRequests.at(-1)!.input as string).mvp).toEqual(["A3 Player"]);
    expect(String(aiRequests.at(-1)!.input)).not.toMatch(/ORGANIZER|ga-p3|method/);
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.error).toContain("Telegram group"); // no group → nothing sent
    await selectChat(id, await chatRef());
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    expect(sends("sendMessage")).toHaveLength(1);
    expect(String(sends("sendMessage")[0].body.text)).toContain("A3 Player");
    expect(sends("sendPoll")).toHaveLength(0);
  });

  it("15: an active Player Vote cannot be silently replaced by an organizer selection (and a saved selection blocks starting a vote until reset)", async () => {
    const id = await readyMatch();
    await selectChat(id, await chatRef());
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p1" });
    expect((await pgJson(id, { action: "start_mvp" })).body.code).toBe("MVP_METHOD_LOCKED");
    expect(sends("sendPoll")).toHaveLength(0);
    expect((await pg(id, { action: "reset_mvp_selection" })).status).toBe(200); // explicit reset
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ method: null, selectedPlayerId: null });
    expect((await pg(id, { action: "start_mvp" })).status).toBe(201);
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p1" })).body.code).toBe("MVP_METHOD_LOCKED");
    expect((await pgJson(id, { action: "reset_mvp_selection" })).status).toBe(400);
    expect((await postGameOf(id)).mvp).toMatchObject({ method: "PLAYER_VOTE", voteLocked: true, open: true, selection: null });
  });

  it("a definitively FAILED poll attempt does not lock the method; an UNCERTAIN one does", async () => {
    const id = await readyMatch();
    await selectChat(id, await chatRef());
    sendPollMode = "reject";
    expect((await pg(id, { action: "start_mvp" })).status).toBe(502);
    expect((await postGameOf(id)).mvp.voteLocked).toBe(false);
    expect((await pg(id, { action: "save_mvp_selection", playerId: "ga-p4" })).status).toBe(200); // switch is allowed
    await pg(id, { action: "reset_mvp_selection" });
    sendPollMode = "ambiguous";
    expect((await pg(id, { action: "start_mvp" })).status).toBe(502);
    expect((await postGameOf(id)).mvp.voteLocked).toBe(true);
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p4" })).body.code).toBe("MVP_METHOD_LOCKED");
  });

  it("16: a published Player of the Match cannot be silently replaced by either method", async () => {
    const id = await readyMatch();
    await selectChat(id, await chatRef());
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p1" });
    await pg(id, { action: "publish_mvp" });
    expect((await pgJson(id, { action: "save_mvp_selection", playerId: "ga-p2" })).body.code).toBe("MVP_LOCKED");
    expect((await pgJson(id, { action: "reset_mvp_selection" })).body.code).toBe("MVP_LOCKED");
    expect((await pgJson(id, { action: "start_mvp" })).body.code).toBe("MVP_LOCKED");
    expect(sends("sendPoll")).toHaveLength(0);
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ winnerPlayerIds: ["ga-p1"] });
  });

  it("14: same-day Matches keep separate Player of the Match (one by selection, one by vote)", async () => {
    await prisma.telegramUserLink.create({ data: { userId: 333n, playerId: "ga-p3", groupId: "ga" } });
    const a = await readyMatch("2026-10-10", "18:00");
    const b = await readyMatch("2026-10-10", "21:00");
    await pg(a, { action: "save_mvp_selection", playerId: "ga-p4" });
    await pg(a, { action: "publish_mvp" });
    await selectChat(b, await chatRef());
    await pg(b, { action: "start_mvp" });
    const pollB = (await prisma.telegramPoll.findFirstOrThrow({ where: { matchId: b, kind: "MVP" } })).pollId;
    await vote(pollB, 333, [OPTION.p1]);
    await pg(b, { action: "close_mvp" });
    await pg(b, { action: "publish_mvp" });
    session = null;
    expect([(await pageView(a))!.mvp, (await pageView(b))!.mvp]).toEqual([
      { names: ["A4 Player"], shared: false },
      { names: ["A1 Player"], shared: false },
    ]);
    expect((await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: a } })).method).toBe("ORGANIZER_SELECTION");
    expect((await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: b } })).method).toBe("PLAYER_VOTE");
  });
});

describe("M9-D enhancement — Regenerate AI Recap (server side)", () => {
  it("4/5/6: regenerating returns a new draft and never saves, publishes or sends; the published recap stays as it was", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    const id = await playedMatch();
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    await pg(id, { action: "save_recap", content: "Published recap." });
    await pg(id, { action: "publish_recap" });
    aiText = "Team 1 takes it 5–3 ⚽";
    expect((await pgJson(id, { action: "generate_recap" })).body.text).toBe("Team 1 takes it 5–3 ⚽");
    aiText = "A two-goal win for Team 1, 5–3 🏆";
    expect((await pgJson(id, { action: "generate_recap" })).body.text).toBe("A two-goal win for Team 1, 5–3 🏆");
    expect(await prisma.matchRecap.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ content: "Published recap.", publishedAt: expect.any(Date) });
    session = null;
    expect((await pageView(id))!.recap).toEqual({ text: "Published recap." });
    expect(tgCalls.filter((c) => c.method === "sendMessage" || c.method === "sendPoll")).toHaveLength(0);
    expect(await prisma.matchMvp.count({ where: { matchId: id } })).toBe(0);
    expect((await prisma.matchResult.findUniqueOrThrow({ where: { matchId: id } })).scoresJson).toBe(JSON.stringify([{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }]));
  });
});

describe("M9-D — Post Match Summary to Telegram", () => {
  /** Published teams T1=[p1,p2], T2=[p3,p4]; venue "Forekicks"; Group A chat selected; result 5–3 published. */
  async function summaryMatch(date = "2026-10-12", startTime = "20:00") {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date, startTime, locationName: "Forekicks" })).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]), date);
    await selectChat(id, await chatRef());
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    return id;
  }
  const postSummary = (id: string, extra: Record<string, unknown> = {}, grp = A) => pgJson(id, { action: "post_message", kind: "summary", ...extra }, grp);
  const summaries = (id: string) => prisma.messageDelivery.findMany({ where: { matchId: id, eventType: "MATCH_SUMMARY_POSTED" } });

  it("6/13/14/15/17/24: result-only summary — exactly one message and one delivery; repeat is a no-op; nothing is published; PUBLIC link", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    const id = await summaryMatch();
    // Drafts exist but are NOT published → must not be sent.
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p3" });
    await pg(id, { action: "save_recap", content: "Draft recap — not published." });
    const before = await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } });
    expect((await postSummary(id)).body.state).toBe("posted");
    expect(msgs()).toHaveLength(1);
    const text = String(msgs()[0].body.text);
    expect(text).toContain("🏁 MATCH COMPLETE");
    expect(text).toContain("⚽ Team 1  5 — 3  Team 2");
    expect(text).toContain("🏆 Team 1 wins!");
    expect(text).toContain("📍 Forekicks");
    expect(text).toContain(`href="${BASE}/g/org-a/group-a/m/${id}"`);
    expect(text).not.toMatch(/Player of the Match|A3 Player|Match Recap|Draft recap/); // 10/11: unpublished excluded
    expect(await summaries(id)).toHaveLength(1);
    expect((await postSummary(id)).body.state).toBe("already_posted");
    expect(msgs()).toHaveLength(1);
    expect(await summaries(id)).toHaveLength(1);
    // 17: posting published nothing.
    expect(await prisma.matchMvp.findUniqueOrThrow({ where: { matchId: id } })).toEqual(before);
    expect(await prisma.matchRecap.findUniqueOrThrow({ where: { matchId: id } })).toMatchObject({ publishedAt: null });
    expect((await postGameOf(id)).messages.summary).toBe("posted");
  });

  it("7/8/9/12/16: MVP and recap appear once published; each published change asks for an explicit updated post", async () => {
    const id = await summaryMatch();
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p3" });
    await pg(id, { action: "publish_mvp" });
    await postSummary(id);
    expect(String(msgs().at(-1)!.body.text)).toContain("<b>⭐ Player of the Match</b>\nA3 Player"); // 7
    expect(String(msgs().at(-1)!.body.text)).not.toContain("Match Recap");

    await pg(id, { action: "save_recap", content: "Team 1 takes it, 5–3! 🏆" });
    expect((await postGameOf(id)).messages.summary).toBe("posted"); // unpublished recap doesn't change it
    await pg(id, { action: "publish_recap" });
    expect((await postGameOf(id)).messages.summary).toBe("updated_available"); // 16
    expect((await postSummary(id)).body.state).toBe("updated_available"); // never auto-sent
    expect(msgs()).toHaveLength(1);
    expect((await postSummary(id, { intent: "post_updated" })).body.state).toBe("posted");
    const all = String(msgs().at(-1)!.body.text);
    expect(all).toContain("A3 Player"); // 9
    expect(all).toContain("<b>📝 Match Recap</b>\nTeam 1 takes it, 5–3! 🏆"); // 12
    expect(all.indexOf("Player of the Match")).toBeLessThan(all.indexOf("Match Recap"));

    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 6 }, { teamNumber: 2, score: 3 }] }); // published correction
    expect((await postGameOf(id)).messages.summary).toBe("updated_available");
    await pg(id, { action: "save_recap", content: "Team 1 takes it, 6–3! 🏆" });
    expect((await postSummary(id, { intent: "post_updated" })).body.state).toBe("posted");
    expect(String(msgs().at(-1)!.body.text)).toContain("⚽ Team 1  6 — 3  Team 2");
    expect(await summaries(id)).toHaveLength(3);
  });

  it("8: result + recap without MVP; individual post-game posts no longer exist (Match Summary only)", async () => {
    const id = await summaryMatch();
    await pg(id, { action: "save_recap", content: "Bragging rights to Team 1! ⚽" });
    await pg(id, { action: "publish_recap" });
    await postSummary(id);
    const text = String(msgs().at(-1)!.body.text);
    expect(text).toContain("<b>📝 Match Recap</b>\nBragging rights to Team 1! ⚽");
    expect(text).not.toContain("Player of the Match");
    for (const kind of ["result", "mvp", "recap"]) expect((await pgJson(id, { action: "post_message", kind })).status, kind).toBe(400);
    expect(msgs()).toHaveLength(1);
  });

  it("18/19: MEMBER cannot post; another Group's owner cannot reach the Match; result must be published; a chat must be selected", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch()).data.match.id;
    await publishFor(id, teamsOf([["ga-p1"], ["ga-p2"]]));
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 1 }, { teamNumber: 2, score: 0 }] });
    expect((await postSummary(id)).body.error).toBe("Choose a connected Telegram group for this match first.");
    await selectChat(id, await chatRef());
    expect((await postSummary(id)).body.error).toBe("Publish the result before posting the match summary.");
    await pg(id, { action: "publish_result" });
    await signInAs("member@example.test");
    expect((await postSummary(id)).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await postSummary(id, {}, B)).status).toBe(404);
    expect(tgCalls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect(await summaries(id)).toHaveLength(0);
  });

  it("20: same-day Matches post their own summaries and links", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    const a = await summaryMatch("2026-10-10", "18:00");
    const b = await summaryMatch("2026-10-10", "21:00");
    await pg(b, { action: "save_result", scores: [{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 2 }] });
    await postSummary(a);
    expect(String(msgs().at(-1)!.body.text)).toContain(`/m/${a}`);
    await postSummary(b);
    const tb = String(msgs().at(-1)!.body.text);
    expect(tb).toContain(`/m/${b}`);
    expect(tb).toContain("⚽ Team 1  2 — 2  Team 2");
    expect(tb).toContain("🤝 Draw");
    expect(await summaries(a)).toHaveLength(1);
    expect(await summaries(b)).toHaveLength(1);
  });

  it("22/23: PRIVATE → no link; LINK → the secure /share/m/<id>#token link (from the organizer's current share link)", async () => {
    vi.stubEnv("APP_BASE_URL", BASE);
    const id = await summaryMatch();
    await setVisibility("ga", "LINK");
    const { token } = await shareLink("ga");
    await postSummary(id, { shareUrl: `${BASE}/share#${token}` });
    expect(String(msgs().at(-1)!.body.text)).toContain(`${BASE}/share/m/${id}#${token}`);
    await setVisibility("ga", "PRIVATE");
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 4 }] });
    await postSummary(id, { intent: "post_updated", shareUrl: `${BASE}/share#${token}` });
    expect(String(msgs().at(-1)!.body.text)).not.toMatch(/https?:\/\//);
    expect(String(msgs().at(-1)!.body.text)).not.toContain(token);
  });
});

describe("M9-D — Telegram readiness fixes (production sequences)", () => {
  async function prodMatch(date = "2026-10-12", startTime = "20:00") {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date, startTime, locationName: "Forekicks" })).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]), date);
    await selectChat(id, await chatRef());
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    return id;
  }
  const state = async (id: string) => (await postGameOf(id)).messages;

  it("Part 5 / 7–9: post 5–3 → posted (no button); same 5–3 again → still posted; 6–3 → updated (no auto-send); post update → posted", async () => {
    const id = await prodMatch();
    expect((await state(id)).summary).toBe("not_posted");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    expect((await state(id)).summary).toBe("posted");
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    expect((await state(id)).summary).toBe("posted");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("already_posted");
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 6 }, { teamNumber: 2, score: 3 }] });
    expect((await state(id)).summary).toBe("updated_available");
    expect(msgs()).toHaveLength(1); // nothing sent automatically
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "post_updated" })).body.state).toBe("posted");
    expect(msgs()).toHaveLength(2);
    expect(String(msgs()[1].body.text)).toContain("⚽ Team 1  6 — 3  Team 2");
    expect((await state(id)).summary).toBe("posted");
  });

  it("14: historical individual deliveries (e.g. a pre-scoreboard result post) stay untouched and do not affect the Match Summary", async () => {
    const id = await prodMatch("2026-10-05");
    const dest = (await prisma.telegramChat.findFirstOrThrow({ where: { groupId: "ga" } })).chatId.toString();
    const legacy = await prisma.messageDelivery.create({
      data: { groupId: "ga", matchId: id, eventType: "MATCH_RESULT_POSTED", channel: "TELEGRAM", destination: dest, contentHash: legacyResultHash({ date: "2026-10-05", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] }), status: "SENT", claimedAt: new Date(), sentAt: new Date() },
    });
    expect(legacy.contentHash.slice(0, 12)).toBe("1f6253505817");
    expect((await state(id)).summary).toBe("not_posted");
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    expect(msgs()).toHaveLength(1);
    expect(await prisma.messageDelivery.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy); // untouched
    expect((await state(id)).summary).toBe("posted");
  });

  it("10/11: FAILED is never 'posted' (plain retry); UNCERTAIN needs the explicit recovery retry", async () => {
    const id = await prodMatch();
    sendMessageMode = "reject";
    await pg(id, { action: "post_message", kind: "summary" });
    expect((await state(id)).summary).toBe("failed");
    sendMessageMode = "ambiguous";
    await pg(id, { action: "post_message", kind: "summary" });
    expect((await state(id)).summary).toBe("uncertain");
    sendMessageMode = "ok";
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("uncertain");
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "retry_uncertain" })).body.state).toBe("posted");
    expect((await state(id)).summary).toBe("posted");
  });

  it("Part 4 / 4–6, 15: summary without the saved recap → publish recap (no send) → updated → post update → posted with result + MVP + recap", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-itest");
    vi.stubEnv("OPENAI_BASE_URL", "https://ai.itest/v1");
    aiText = "Team 1 takes it over Team 2, 5–3! Player of the Match honors go to A3 Player 🏆";
    const id = await prodMatch();
    await pg(id, { action: "save_mvp_selection", playerId: "ga-p3" });
    await pg(id, { action: "publish_mvp" });
    const gen = await pgJson(id, { action: "generate_recap" });
    await pg(id, { action: "save_recap", content: gen.body.text }); // saved, NOT published
    let pgv = await postGameOf(id);
    expect(summaryReadiness(pgv, true).items.map((i) => [i.key, i.included, i.note])).toEqual([
      ["result", true, null],
      ["mvp", true, null],
      ["recap", false, "saved, not published"],
    ]);
    expect(summaryReadiness(pgv, true).publishRecapShortcut).toBe(true);

    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    const first = String(msgs().at(-1)!.body.text);
    expect(first).toContain("⚽ Team 1  5 — 3  Team 2");
    expect(first).toContain("A3 Player");
    expect(first).not.toContain("Match Recap");

    const sent = msgs().length;
    expect((await pg(id, { action: "publish_recap" })).status).toBe(200); // the same publish action as the Recap section
    expect(msgs()).toHaveLength(sent); // publishing sends nothing
    pgv = await postGameOf(id);
    expect(pgv.recap.published).toBe(true);
    expect(pgv.messages.summary).toBe("updated_available");
    expect(summaryReadiness(pgv, true)).toMatchObject({ summaryChanged: true, publishRecapShortcut: false });
    expect(summaryReadiness(pgv, true).items[2]).toMatchObject({ included: true });

    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "post_updated" })).body.state).toBe("posted");
    expect(msgs()).toHaveLength(sent + 1);
    const second = String(msgs().at(-1)!.body.text);
    for (const part of ["⚽ Team 1  5 — 3  Team 2", "A3 Player", "<b>📝 Match Recap</b>", "Team 1 takes it over Team 2, 5–3!"]) expect(second).toContain(part);
    expect((await state(id)).summary).toBe("posted");
  });

  it("16/17: same-day and cross-Group isolation of result/summary states; MEMBER cannot post", async () => {
    const a = await prodMatch("2026-10-10", "18:00");
    const b = await prodMatch("2026-10-10", "21:00");
    await pg(a, { action: "post_message", kind: "summary" });
    expect((await state(a)).summary).toBe("posted");
    expect((await state(b)).summary).toBe("not_posted");
    await signInAs("member@example.test");
    expect((await pg(b, { action: "post_message", kind: "summary" })).status).toBe(404);
    await signInAs("owner-b@example.test");
    expect((await pg(b, { action: "post_message", kind: "summary" }, B)).status).toBe(404);
    expect(msgs()).toHaveLength(1);
  });
});

describe("M9 post-game streamlining — published change → stale summary; agent boundary", () => {
  async function postedMatch() {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date: "2026-10-12", startTime: "20:00", locationName: "Forekicks" })).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]));
    await selectChat(id, await chatRef());
    await pg(id, { action: "save_result", scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] });
    await pg(id, { action: "publish_result" });
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("posted");
    return id;
  }

  it("6–10: Save Changes on a published result sends nothing, stays published, makes the summary stale; the updated summary posts once, then it is posted again", async () => {
    const id = await postedMatch();
    const before = msgs().length;
    expect((await pgJson(id, { action: "save_result", scores: [{ teamNumber: 1, score: 6 }, { teamNumber: 2, score: 3 }] })).body).toEqual({ ok: true, published: true });
    expect(msgs()).toHaveLength(before); // 7
    session = null;
    expect((await pageView(id))!.result!.teams[0].score).toBe(6); // published correction
    await signInAs("owner@example.test");
    expect((await postGameOf(id)).messages.summary).toBe("updated_available"); // 8
    expect((await pgJson(id, { action: "post_message", kind: "summary", intent: "post_updated" })).body.state).toBe("posted");
    expect(msgs()).toHaveLength(before + 1); // 9
    expect(String(msgs().at(-1)!.body.text)).toContain("⚽ Team 1  6 — 3  Team 2");
    expect((await postGameOf(id)).messages.summary).toBe("posted"); // 10
    expect((await pgJson(id, { action: "post_message", kind: "summary" })).body.state).toBe("already_posted"); // 24
    expect(msgs()).toHaveLength(before + 1);
  });

  it("agent boundary: the same authoritative operations run without HTTP (typed commands + readiness), with the same authorization", async () => {
    await signInAs("owner@example.test");
    const id = (await createMatch({ date: "2026-10-12", startTime: "20:00" })).data.match.id;
    await publishFor(id, teamsOf([["ga-p1", "ga-p2"], ["ga-p3", "ga-p4"]]));
    const ctx = await requireTenantContextForSlugs(A);
    let r = await getMatchSummaryReadiness(ctx, id);
    expect(r).toMatchObject({ resultPublished: false, canPost: false });
    expect((await runPostGameAction(ctx, id, { action: "save_result", scores: [{ teamNumber: 1, score: 2 }, { teamNumber: 2, score: 1 }] })).status).toBe(200);
    expect((await runPostGameAction(ctx, id, { action: "publish_result" })).status).toBe(200);
    expect((await runPostGameAction(ctx, id, { action: "save_recap", content: "Thanks all!" })).status).toBe(200);
    r = await getMatchSummaryReadiness(ctx, id);
    expect(r).toMatchObject({ resultPublished: true, destinationConnected: false, canPost: false, publishRecapShortcut: true });
    expect(r!.items.find((i) => i.key === "recap")).toMatchObject({ included: false, note: "saved, not published" });
    await selectChat(id, await chatRef());
    expect((await getMatchSummaryReadiness(ctx, id))!.canPost).toBe(true);
    expect(tgCalls).toHaveLength(0); // readiness and data commands never send
    // Same authorization for non-HTTP callers: a MEMBER context cannot post.
    await signInAs("member@example.test");
    const memberCtx = await requireTenantContextForSlugs(A);
    expect((await runPostGameAction(memberCtx, id, { action: "post_message", kind: "summary", intent: "post" })).status).toBe(404);
    expect((await getMatchSummaryReadiness(memberCtx, id))!.canPost).toBe(false);
    expect(tgCalls).toHaveLength(0);
  });
});
