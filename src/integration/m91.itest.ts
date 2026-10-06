/**
 * M9.1 — launch-readiness fixes, REAL DATABASE (guarded local test DB only).
 *
 *  1. Telegram team-post delivery recovery through the existing routes
 *     (telegram/close-and-post, telegram/delivery) that the Match Workspace
 *     now exposes: posted / failed → retry / uncertain → warning + mark as
 *     sent (ZERO Telegram calls) or explicit retry; OWNER/ADMIN only;
 *     tenant-scoped. Telegram is a programmable STUB — nothing leaves the box.
 *  2. Balance weights are organizer configuration: OWNER/ADMIN may read and
 *     write them; MEMBER, unauthenticated and foreign tenants receive none.
 *     The team name (player-facing display data) stays readable.
 *  3. Recap save ≠ publish; neither sends anything; the Match Summary send
 *     path is unchanged.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { loadMatchForViewer } from "@/lib/matchPage";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as deliveryRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/delivery/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";
import * as teamNameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/team-name/route";
import * as publicTeamNameRoute from "@/app/api/public/[organizationSlug]/[groupSlug]/team-name/route";
import * as postGameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/post-game/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = new Date("2026-10-08T00:00:00Z");
const TEAMS = JSON.stringify([
  { teamNumber: 1, players: [{ id: "p1", firstName: "Ann", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 3 }] },
  { teamNumber: 2, players: [{ id: "p2", firstName: "Bo", lastName: "Two", position: "FORWARD", rating: "GOOD", stamina: 3 }] },
]);

// ------------------------------------------------------------ Telegram stub (no network)
let sendMode: "ok" | "reject" | "ambiguous" = "ok";
let tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  if (method === "sendMessage" && sendMode === "reject") return { ok: true, status: 200, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) } as unknown as Response;
  if (method === "sendMessage" && sendMode === "ambiguous") throw new TypeError("fetch failed");
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) } as unknown as Response;
}
const sends = () => tgCalls.filter((c) => c.method === "sendMessage").length;

const signIn = async (who: string | null) => {
  if (!who) return void (session = null);
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};
const json = (method: string, body?: unknown, url = "http://itest.local/") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const g = (at = A) => ({ params: Promise.resolve(at) });
const post = async (body: Record<string, unknown>, at = A) => {
  const res = await closePostRoute.POST(json("POST", { pollId: "poll-1", teamGenerationId: "gen-1", ...body }) as never, g(at) as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const status = async (at = A) => {
  const res = await deliveryRoute.GET(json("GET", undefined, "http://itest.local/?pollId=poll-1&teamGenerationId=gen-1") as never, g(at) as never);
  return { status: res.status, body: (await res.json()) as { state?: string; deliveryId?: string | null } };
};
const markSent = async (deliveryId: string, at = A) => {
  const res = await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId }) as never, g(at) as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

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
    data: [
      { id: "p1", groupId: "ga", firstName: "Ann", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 3 },
      { id: "p2", groupId: "ga", firstName: "Bo", lastName: "Two", position: "FORWARD", rating: "GOOD", stamina: 3 },
    ],
  });
  const chat = await prisma.telegramChat.create({ data: { chatId: BigInt(-5001), title: "Group chat", groupId: "ga" } });
  await prisma.match.create({ data: { id: "m1", groupId: "ga", date: DAY, telegramChatId: chat.id } });
  await prisma.teamGeneration.create({ data: { id: "gen-1", groupId: "ga", matchId: "m1", date: DAY, teamsJson: TEAMS } });
  await prisma.telegramPoll.create({
    data: { pollId: "poll-1", chatId: BigInt(-5001), messageId: null, question: "Playing?", optionsJson: "[]", pollDate: DAY, isClosed: false, groupId: "ga", matchId: "m1", kind: "ATTENDANCE" },
  });
  await prisma.groupSetting.createMany({
    data: [
      { groupId: "ga", key: "teamName", value: "Riverside Rovers" },
      { groupId: "ga", key: "balanceWeights", value: JSON.stringify({ staminaCoef: 1.5, positionWeights: { DEFENDER: 3 } }) },
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
  vi.stubEnv("APP_BASE_URL", "https://tbp.itest");
  vi.stubEnv("OPENAI_API_KEY", "");
});
beforeEach(async () => {
  session = null;
  sendMode = "ok";
  tgCalls = [];
  otherNetwork = 0;
  await seed();
  await signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("1 — Telegram team-post delivery recovery", () => {
  it("normal post: one message, state posted (no recovery); re-posting sends nothing", async () => {
    expect((await status()).body.state).toBe("not_posted");
    expect(await post({ intent: "post" })).toMatchObject({ status: 200, body: { ok: true, status: "posted" } });
    expect(sends()).toBe(1);
    expect((await status()).body.state).toBe("posted");
    expect((await post({ intent: "post" })).body.status).toBe("already_posted");
    expect(sends()).toBe(1);
  });

  it("definite failure → state failed → 'Retry posting teams' (intent post) re-uses the same delivery and posts once", async () => {
    sendMode = "reject";
    expect(await post({ intent: "post" })).toMatchObject({ status: 502, body: { status: "telegram_rejected" } });
    const failed = await status();
    expect(failed.body.state).toBe("failed");
    sendMode = "ok";
    expect((await post({ intent: "post" })).body.status).toBe("posted");
    expect(sends()).toBe(2);
    expect(await prisma.messageDelivery.count()).toBe(1); // the failed row was retried, not duplicated
    expect((await prisma.messageDelivery.findFirstOrThrow()).attempts).toBe(2);
  });

  it("uncertain → never auto-retried; a plain post is refused and sends nothing; mark as sent records SENT with ZERO Telegram calls", async () => {
    sendMode = "ambiguous";
    expect(await post({ intent: "post" })).toMatchObject({ status: 502, body: { status: "delivery_unknown" } });
    const uncertain = await status();
    expect(uncertain.body.state).toBe("uncertain");
    expect(uncertain.body.deliveryId).toBeTruthy();
    const before = tgCalls.length;
    sendMode = "ok";
    expect(await post({ intent: "post" })).toMatchObject({ status: 409, body: { status: "delivery_uncertain", deliveryId: uncertain.body.deliveryId } });
    expect(tgCalls.length).toBe(before); // refused before any Telegram side effect

    expect(await markSent(uncertain.body.deliveryId!)).toEqual({ status: 200, body: { ok: true, status: "marked_sent" } });
    expect(tgCalls.length).toBe(before); // ZERO Telegram calls
    const row = await prisma.messageDelivery.findFirstOrThrow();
    expect(row).toMatchObject({ status: "SENT", resolution: "MARKED_SENT", resolvedByUserId: "u-owner" });
    expect((await status()).body.state).toBe("posted");
    expect(await markSent(uncertain.body.deliveryId!)).toMatchObject({ status: 409 }); // only an uncertain delivery can be marked
  });

  it("uncertain → explicit retry (retry_uncertain + that deliveryId) sends exactly once; a wrong deliveryId is refused", async () => {
    sendMode = "ambiguous";
    await post({ intent: "post" });
    const { deliveryId } = (await status()).body;
    sendMode = "ok";
    const before = sends();
    expect((await post({ intent: "retry_uncertain", deliveryId: "someone-else" })).status).toBe(409);
    expect(sends()).toBe(before);
    expect((await post({ intent: "retry_uncertain", deliveryId })).body.status).toBe("posted");
    expect(sends()).toBe(before + 1);
    expect((await status()).body.state).toBe("posted");
  });

  it("ADMIN may recover; MEMBER gets the generic 404 for status, post, retry and mark as sent", async () => {
    sendMode = "ambiguous";
    await post({ intent: "post" });
    const { deliveryId } = (await status()).body;
    const before = tgCalls.length;
    await signIn("member");
    expect((await status()).status).toBe(404);
    expect((await post({ intent: "retry_uncertain", deliveryId })).status).toBe(404);
    expect((await markSent(deliveryId!)).status).toBe(404);
    expect(tgCalls.length).toBe(before);
    expect((await prisma.messageDelivery.findFirstOrThrow()).status).toBe("UNCERTAIN");
    await signIn("admin");
    expect((await markSent(deliveryId!)).status).toBe(200);
  });

  it("cross-tenant: another Organization cannot see or recover this delivery (404), and its own URL cannot reach it", async () => {
    sendMode = "ambiguous";
    await post({ intent: "post" });
    const { deliveryId } = (await status()).body;
    await signIn("other");
    expect((await status()).status).toBe(404);
    expect((await markSent(deliveryId!)).status).toBe(404);
    expect((await markSent(deliveryId!, B)).status).toBe(404);
    expect((await post({ intent: "retry_uncertain", deliveryId }, B)).status).toBe(404);
    expect((await prisma.messageDelivery.findFirstOrThrow()).status).toBe("UNCERTAIN");
    expect(otherNetwork).toBe(0);
  });
});

describe("2 — balance weights are organizer-only configuration", () => {
  const readWeights = async (at = A) => {
    const res = await weightsRoute.GET(json("GET") as never, g(at) as never);
    return { status: res.status, text: await res.text() };
  };
  it.each(["owner", "admin"])("%s reads the stored configuration", async (who) => {
    await signIn(who);
    const r = await readWeights();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).weights).toMatchObject({ staminaCoef: 1.5, positionWeights: { DEFENDER: 3 } });
  });
  it("MEMBER and unauthenticated callers receive no balance weights", async () => {
    for (const who of ["member", null]) {
      await signIn(who);
      const r = await readWeights();
      expect(r.status, String(who)).not.toBe(200);
      expect(r.text).not.toMatch(/weights|staminaCoef|positionWeights/);
    }
  });
  it("another Organization: 404 (its own URL cannot reach Group A either)", async () => {
    await signIn("other");
    expect((await readWeights()).status).toBe(404);
  });
  it("display name still works: MEMBER reads the team name; the public route serves it (and only it)", async () => {
    await signIn("member");
    expect(await (await teamNameRoute.GET(json("GET") as never, g() as never)).json()).toEqual({ teamName: "Riverside Rovers" });
    await signIn(null);
    const pub = await publicTeamNameRoute.GET(json("GET") as never, g() as never);
    expect(await pub.json()).toEqual({ teamName: "Riverside Rovers" });
    expect((await loadMatchForViewer({ ...A, matchId: "m1" }))?.group.teamName).toBe("Riverside Rovers");
  });
  it("organizer writes continue to work; MEMBER writes stay 404", async () => {
    const put = (weights: unknown) => weightsRoute.PUT(json("PUT", { weights }) as never, g() as never);
    expect((await put({ staminaCoef: 2, positionWeights: { DEFENDER: 1 } })).status).toBe(200);
    await signIn("member");
    expect((await put({ staminaCoef: 9 })).status).toBe(404);
    await signIn("owner");
    expect(JSON.parse((await readWeights()).text).weights.staminaCoef).toBe(2);
  });
});

describe("3 — recap save ≠ publish; no Telegram from either", () => {
  const pg = async (body: unknown) => {
    const res = await postGameRoute.POST(json("POST", body) as never, { params: Promise.resolve({ ...A, matchId: "m1" }) } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  it("save stores a draft (not visible to players), publish makes it visible; neither sends", async () => {
    await pg({ action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 2, scoreB: 1 }] });
    await pg({ action: "publish_result" });
    expect(await pg({ action: "save_recap", content: "Great   game!  " })).toMatchObject({ status: 200, body: { ok: true, published: false } });
    expect((await prisma.matchRecap.findUniqueOrThrow({ where: { matchId: "m1" } })).content).toBe("Great game!"); // server normalization (shared with the editor)
    const s = session;
    session = null;
    expect((await loadMatchForViewer({ ...A, matchId: "m1" }))?.recap).toBeNull();
    session = s;
    expect((await pg({ action: "publish_recap" })).status).toBe(200);
    session = null;
    expect((await loadMatchForViewer({ ...A, matchId: "m1" }))?.recap).toEqual({ text: "Great game!" });
    expect(tgCalls).toEqual([]);
    expect(await prisma.messageDelivery.count()).toBe(0);
  });
  it("Match Summary remains the only post-game send (one explicit message)", async () => {
    await pg({ action: "save_result", fixtures: [{ teamA: 1, teamB: 2, scoreA: 2, scoreB: 1 }] });
    await pg({ action: "publish_result" });
    await pg({ action: "save_recap", content: "Great game!" });
    await pg({ action: "publish_recap" });
    expect(tgCalls).toEqual([]);
    expect((await pg({ action: "post_message", kind: "summary" })).status).toBe(200);
    expect(tgCalls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(String(tgCalls[0].body.text)).toContain("Great game!");
  });
});
