/**
 * M6-B — REAL-DATABASE tests for canonical Close Poll & Post Teams on
 * durable MessageDelivery records (replaces the former mocked
 * close-and-post route test; every scenario it covered is kept here),
 * plus the Monday workflow end to end.
 *
 * Guarded local TEST database only. Real routes/services/Prisma; only the
 * NextAuth session lookup is mocked. Telegram is a scripted fetch stub
 * (api.telegram.org only) — no real Telegram call; any other host is a
 * counted, forbidden network call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { formatTeamsHtml } from "@/lib/telegramFormat";
import { generateToken, hashToken } from "@/lib/secureToken";
import * as closePostRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/close-and-post/route";
import * as deliveryRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/delivery/route";
import * as createPollRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/create-poll/route";
import * as importRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/import/route";
import * as linkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/link/route";
import * as usersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";
import * as generateRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/generate/route";
import * as publishRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/publish/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";

const BASE = "https://teambalancepro.test";
const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const B = { organizationSlug: "org-b", groupSlug: "group-b" };
const DAY = new Date("2026-10-05T00:00:00.000Z");
const p = (x: { organizationSlug: string; groupSlug: string }) => ({ params: Promise.resolve(x) });
const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------------------------------------------------------------- Telegram stub
type TgCall = { method: string; body: Record<string, unknown> };
let tgCalls: TgCall[] = [];
let tgPlan: Record<string, Array<() => unknown>> = {};
let otherNetworkCalls = 0;
let tgMessageId = 900;
const tg = (body: unknown) => ({ json: async () => body }) as unknown as Response;
const timeoutError = () => {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  throw e;
};
const originalFetch = global.fetch;
const sends = () => tgCalls.filter((c) => c.method === "sendMessage");
const stops = () => tgCalls.filter((c) => c.method === "stopPoll");

async function fakeFetch(url: unknown, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetworkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }
  const method = u.split("/").pop()!;
  tgCalls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  const planned = tgPlan[method]?.shift();
  if (planned) return planned() as Response;
  if (method === "sendMessage") return tg({ ok: true, result: { message_id: ++tgMessageId } });
  if (method === "sendPoll") return tg({ ok: true, result: { message_id: 77, poll: { id: "tg-poll-new" } } });
  return tg({ ok: true, result: true });
}

// ---------------------------------------------------------------- fixtures
const TEAMS = [
  { teamNumber: 1, players: [{ id: "a1", firstName: "Doni", lastName: "Alpha", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5 }] },
  { teamNumber: 2, players: [{ id: "a2", firstName: "Eli", lastName: "Beta", position: "DEFENDER", rating: "GOOD", stamina: 3 }] },
];

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","MessageDelivery","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  for (const [suffix, orgId, groupId, chatId] of [["a", "org-a-id", "ga", 1001n], ["b", "org-b-id", "gb", 2001n]] as const) {
    const user = await prisma.user.create({ data: { email: `owner-${suffix}@example.test`, name: `Owner ${suffix}`, passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt: verified } });
    await prisma.organization.create({ data: { id: orgId, name: `Org ${suffix}`, slug: `org-${suffix}`, plan: "LEGACY" } });
    await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: orgId, role: "OWNER" } });
    await prisma.group.create({ data: { id: groupId, organizationId: orgId, name: `group-${suffix}`, slug: `group-${suffix}`, timezone: "America/New_York", visibility: "PUBLIC" } });
    await prisma.telegramChat.create({ data: { chatId, title: `Chat ${suffix}`, groupId } });
    await prisma.telegramPoll.create({
      data: { pollId: `poll-${suffix}`, chatId, messageId: 5n, question: "Who is playing on 10/5/26?", optionsJson: "[]", pollDate: DAY, groupId },
    });
    await prisma.teamGeneration.create({ data: { id: `gen-${suffix}`, groupId, date: DAY, teamsJson: JSON.stringify(TEAMS) } });
    for (const [pid, first, last, pos] of [[`${suffix}1`, "Doni", "Alpha", "GOALKEEPER"], [`${suffix}2`, "Eli", "Beta", "DEFENDER"]] as const) {
      await prisma.player.create({ data: { id: pid, groupId, firstName: first, lastName: last, position: pos, rating: "GOOD", stamina: 3 } });
    }
  }
}

const post = (body: Record<string, unknown>, g = A) => closePostRoute.POST(json("POST", { pollId: "poll-a", teamGenerationId: "gen-a", ...body }), p(g));
const status = async (g = A, pollId = "poll-a", gen = "gen-a") => {
  const res = await deliveryRoute.GET(new Request(`http://itest.local/?pollId=${pollId}&teamGenerationId=${gen}`), p(g));
  return { res, data: await res.json() };
};
const deliveries = () => prisma.messageDelivery.findMany({ where: { telegramPollId: "poll-a" }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
});

beforeEach(async () => {
  session = null;
  tgCalls = [];
  tgPlan = {};
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", BASE);
  await seed();
  await signInAs("owner-a@example.test");
});

afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ============================================================ validation
describe("close-and-post — validation before any Telegram call or delivery write", () => {
  const nothingHappened = async () => {
    expect(tgCalls).toEqual([]);
    expect(await prisma.messageDelivery.count()).toBe(0);
  };

  it("unauthenticated → 401; invalid tenant → 404", async () => {
    session = null;
    expect((await post({})).status).toBe(401);
    await signInAs("owner-a@example.test");
    expect((await post({}, { organizationSlug: "org-a", groupSlug: "nope" })).status).toBe(404);
    await nothingHappened();
  });

  it("missing teamGenerationId → 400", async () => {
    expect((await closePostRoute.POST(json("POST", { pollId: "poll-a" }), p(A))).status).toBe(400);
    await nothingHappened();
  });

  it("foreign Group's poll, generation, and missing ids are not found", async () => {
    expect((await post({ pollId: "poll-b" })).status).toBe(404);
    expect((await post({ teamGenerationId: "gen-b" })).status).toBe(404);
    expect((await post({ pollId: "nope" })).status).toBe(404);
    expect((await post({ teamGenerationId: "nope" })).status).toBe(404);
    await nothingHappened();
  });

  it("destination substitution: a poll pointing at another Group's Telegram chat is refused", async () => {
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { chatId: 2001n } });
    const res = await post({});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Telegram chat not found" });
    await nothingHappened();
  });

  it("pollDate null and date mismatch are rejected; same day with a time component matches", async () => {
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { pollDate: null } });
    expect((await post({})).status).toBe(400);
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { pollDate: new Date("2026-10-06T00:00:00Z") } });
    expect((await post({})).status).toBe(400);
    await nothingHappened();
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { pollDate: new Date("2026-10-05T23:30:00Z") } });
    expect((await post({})).status).toBe(200);
  });

  it("malformed or wrong-shape persisted teams → 422 before posting", async () => {
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { teamsJson: "not json" } });
    expect((await post({})).status).toBe(422);
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { teamsJson: JSON.stringify([{ nope: 1 }]) } });
    expect((await post({})).status).toBe(422);
    await nothingHappened();
  });

  it("missing bot token fails before any Telegram call or reservation", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect((await post({})).status).toBe(500);
    await nothingHappened();
  });

  it("body groupId/organizationId/teams are ignored — tenant and content come only from the URL and the database", async () => {
    const res = await post({ groupId: "gb", organizationId: "org-b-id", teams: [{ teamNumber: 9, players: [{ firstName: "Forged" }] }] });
    expect(res.status).toBe(200);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.chat_id).toBe("1001");
    expect(String(sends()[0].body.text)).not.toContain("Forged");
    expect((await deliveries())[0]).toMatchObject({ groupId: "ga" });
  });
});

// ============================================================ first post & close
describe("close-and-post — first post", () => {
  it("closes the poll, sends once, ends SENT with the provider id and keeps the legacy columns in step", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "posted", closeStatus: "closed_now", teamGenerationId: "gen-a" });
    expect(tgCalls.map((c) => c.method)).toEqual(["stopPoll", "sendMessage"]);
    expect(stops()[0].body).toEqual({ chat_id: "1001", message_id: 5 });

    const [d] = await deliveries();
    expect(d).toMatchObject({ groupId: "ga", eventType: "TEAMS_PUBLISHED", channel: "TELEGRAM", destination: "1001", status: "SENT", attempts: 1, teamGenerationId: "gen-a", providerMessageId: String(tgMessageId) });
    const poll = await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-a" } });
    expect(poll).toMatchObject({ isClosed: true, teamsPostStatus: "POSTED", postedTeamGenerationId: "gen-a" });
  });

  it("PUBLIC Group: message = the pre-M6 teams text + a 'View teams online' canonical link", async () => {
    await post({});
    const text = String(sends()[0].body.text);
    const body = formatTeamsHtml("10/5/26", TEAMS);
    expect(text).toBe(`${body}\n\n<a href="${BASE}/g/org-a/group-a">View teams online</a>`);
    expect(sends()[0].body).toMatchObject({ parse_mode: "HTML", disable_web_page_preview: true });
    expect(text).not.toMatch(/EXCELLENT|stamina|rating/);
  });

  it("skips stopPoll when already closed locally; 'already been closed' persists isClosed; a close failure never blocks posting", async () => {
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { isClosed: true } });
    expect(await (await post({})).json()).toMatchObject({ status: "posted", closeStatus: "already_closed_locally" });
    expect(stops()).toHaveLength(0);

    await seed();
    await signInAs("owner-a@example.test");
    tgCalls = [];
    tgPlan.stopPoll = [() => tg({ ok: false, error_code: 400, description: "Bad Request: poll has already been closed" })];
    expect(await (await post({})).json()).toMatchObject({ status: "posted", closeStatus: "already_closed_on_telegram" });
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-a" } })).isClosed).toBe(true);

    await seed();
    await signInAs("owner-a@example.test");
    tgCalls = [];
    tgPlan.stopPoll = [() => tg({ ok: false, error_code: 400, description: "Bad Request: message can't be edited" })];
    expect(await (await post({})).json()).toMatchObject({ status: "posted", closeStatus: "close_failed" });
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-a" } })).isClosed).toBe(false);
  });

  it("concurrent double-clicks: exactly one message is sent", async () => {
    const results = await Promise.all([post({}), post({}), post({})]);
    expect(sends()).toHaveLength(1);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(r.status).toBe(409);
    }
    expect(await prisma.messageDelivery.count()).toBe(1);
  });

  it("posting again after SENT → already_posted, nothing sent (an open poll is still closed)", async () => {
    await post({});
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { isClosed: false } });
    tgCalls = [];
    const res = await post({});
    expect(await res.json()).toMatchObject({ ok: true, status: "already_posted", closeStatus: "closed_now" });
    expect(sends()).toHaveLength(0);
    expect(await prisma.messageDelivery.count()).toBe(1);
  });
});

// ============================================================ failures & recovery
describe("close-and-post — known failure, ambiguous outcomes and organizer recovery", () => {
  it("known Telegram rejection → FAILED (retryable, safe detail only); explicit retry → SENT with attempts=2", async () => {
    tgPlan.sendMessage = [() => tg({ ok: false, error_code: 400, description: "Bad Request: chat not found" })];
    const res = await post({});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "telegram_rejected", telegramDescription: "Bad Request: chat not found" });
    expect((await deliveries())[0]).toMatchObject({ status: "FAILED", failureCode: "TELEGRAM_REJECTED", failureDetail: "Bad Request: chat not found" });
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-a" } })).teamsPostStatus).toBeNull();
    expect((await status()).data.state).toBe("failed");

    const retry = await post({ intent: "post" });
    expect(retry.status).toBe(200);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", attempts: 2, failureCode: null });
  });

  it("timeout → UNCERTAIN (never auto-retried); posting again is refused; Mark as sent resolves it without sending", async () => {
    tgPlan.sendMessage = [timeoutError];
    const res = await post({});
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ status: "delivery_unknown" });
    expect((await deliveries())[0]).toMatchObject({ status: "UNCERTAIN", failureCode: "TIMEOUT" });

    tgCalls = [];
    const again = await post({});
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ status: "delivery_uncertain", deliveryId: body.deliveryId });
    expect(tgCalls).toEqual([]);
    expect((await status()).data).toMatchObject({ state: "uncertain", deliveryId: body.deliveryId, failureCode: "TIMEOUT" });

    const mark = await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId: body.deliveryId }), p(A));
    expect(await mark.json()).toEqual({ ok: true, status: "marked_sent" });
    expect(tgCalls).toEqual([]);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "owner-a@example.test" } });
    expect((await deliveries())[0]).toMatchObject({ status: "SENT", resolution: "MARKED_SENT", resolvedByUserId: user.id });
    expect((await prisma.telegramPoll.findUniqueOrThrow({ where: { pollId: "poll-a" } })).teamsPostStatus).toBe("POSTED");
    expect((await status()).data.state).toBe("posted");
  });

  it("network failure and unreadable replies are also UNCERTAIN; explicit retry with the deliveryId re-sends", async () => {
    tgPlan.sendMessage = [() => { throw new TypeError("fetch failed"); }];
    const first = await (await post({})).json();
    expect((await deliveries())[0]).toMatchObject({ status: "UNCERTAIN", failureCode: "NETWORK" });

    expect((await post({ intent: "retry_uncertain", deliveryId: "wrong-id" })).status).toBe(409);
    tgPlan.sendMessage = [() => tg({ weird: true })];
    expect((await post({ intent: "retry_uncertain", deliveryId: first.deliveryId })).status).toBe(502);
    expect((await deliveries())[0]).toMatchObject({ status: "UNCERTAIN", failureCode: "UNREADABLE_RESPONSE", attempts: 2 });

    const ok = await post({ intent: "retry_uncertain", deliveryId: first.deliveryId });
    expect(ok.status).toBe(200);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", attempts: 3 });
    expect(sends()).toHaveLength(3);
  });

  it("a stuck reservation: fresh SENDING blocks everything; once stale it becomes uncertain and recoverable", async () => {
    const d = await prisma.messageDelivery.create({
      data: { groupId: "ga", eventType: "TEAMS_PUBLISHED", channel: "TELEGRAM", destination: "1001", telegramPollId: "poll-a", teamGenerationId: "gen-a", contentHash: "x", status: "SENDING", claimedAt: new Date() },
    });
    expect(await (await post({})).json()).toMatchObject({ status: "post_in_progress_or_unknown" });
    expect((await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId: d.id }), p(A))).status).toBe(409);
    expect((await status()).data.state).toBe("sending");

    await prisma.messageDelivery.update({ where: { id: d.id }, data: { claimedAt: new Date(Date.now() - 3 * 60 * 1000) } });
    expect((await status()).data).toMatchObject({ state: "uncertain", deliveryId: d.id });
    expect(tgCalls).toEqual([]);
    expect((await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId: d.id }), p(A))).status).toBe(200);
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SENT");
  });

  it("provider failures never erase the published generation", async () => {
    tgPlan.sendMessage = [timeoutError];
    await post({});
    expect(await prisma.teamGeneration.findUnique({ where: { id: "gen-a" } })).not.toBeNull();
  });
});

// ============================================================ updated teams
describe("close-and-post — republish and Post Updated Teams", () => {
  it("republishing identical content: still 'posted', nothing offered or sent", async () => {
    await post({});
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { teamsJson: JSON.stringify(TEAMS), updatedAt: new Date(Date.now() + 1000) } });
    expect((await status()).data.state).toBe("posted");
    tgCalls = [];
    expect(await (await post({})).json()).toMatchObject({ status: "already_posted" });
    expect(sends()).toHaveLength(0);
  });

  it("changed teams: 'updated_available'; plain post is refused; explicit post_updated sends ONE more message", async () => {
    await post({});
    const changed = [TEAMS[1], TEAMS[0]].map((t, i) => ({ ...t, teamNumber: i + 1 }));
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { teamsJson: JSON.stringify(changed) } });
    expect((await status()).data.state).toBe("updated_available");

    tgCalls = [];
    const refused = await post({});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: "updated_available" });
    expect(sends()).toHaveLength(0);

    const updated = await post({ intent: "post_updated" });
    expect(await updated.json()).toMatchObject({ status: "posted" });
    expect(sends()).toHaveLength(1);
    expect(String(sends()[0].body.text)).toContain(formatTeamsHtml("10/5/26", changed));
    const rows = await deliveries();
    expect(rows.map((r) => r.status)).toEqual(["SENT", "SENT"]);
    expect(rows[0].contentHash).not.toBe(rows[1].contentHash);

    tgCalls = [];
    expect(await (await post({ intent: "post_updated" })).json()).toMatchObject({ status: "already_posted" });
    expect(sends()).toHaveLength(0);
  });
});

// ============================================================ legacy state
describe("pre-M6-B posting state (TelegramPoll columns) stays safe", () => {
  const legacyPosted = (at: Date) =>
    prisma.telegramPoll.update({
      where: { pollId: "poll-a" },
      data: { teamsPostStatus: "POSTED", postedTeamGenerationId: "gen-a", teamsPostClaimedAt: at, teamsPostedAt: at, isClosed: true },
    });

  it("an already-posted legacy poll is never posted again as a first post", async () => {
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { updatedAt: new Date("2026-10-04T00:00:00Z") } });
    await legacyPosted(new Date("2026-10-05T01:00:00Z"));
    expect((await status()).data.state).toBe("posted");
    const res = await post({});
    expect(await res.json()).toMatchObject({ status: "already_posted" });
    expect(sends()).toHaveLength(0);
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", contentHash: "legacy", teamGenerationId: "gen-a" })]);
  });

  it("legacy poll whose generation was republished after posting → updated_available (explicit only)", async () => {
    await legacyPosted(new Date("2026-10-01T00:00:00Z"));
    await prisma.teamGeneration.update({ where: { id: "gen-a" }, data: { updatedAt: new Date("2026-10-04T00:00:00Z") } });
    expect((await status()).data.state).toBe("updated_available");
    expect((await post({})).status).toBe(409);
    expect(sends()).toHaveLength(0);
    expect((await post({ intent: "post_updated" })).status).toBe(200);
    expect(sends()).toHaveLength(1);
  });

  it("a legacy SENDING state is uncertain, never auto-sent", async () => {
    await prisma.telegramPoll.update({ where: { pollId: "poll-a" }, data: { teamsPostStatus: "SENDING", postedTeamGenerationId: "gen-a", teamsPostClaimedAt: new Date() } });
    const res = await post({});
    expect(await res.json()).toMatchObject({ status: "delivery_uncertain" });
    expect(tgCalls).toEqual([]);
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "UNCERTAIN", failureCode: "STALE_RESERVATION" })]);
  });
});

// ============================================================ tenant isolation
describe("delivery tenant isolation", () => {
  it("Organization B cannot inspect, post, retry or mark Organization A's delivery", async () => {
    tgPlan.sendMessage = [timeoutError];
    const { deliveryId } = await (await post({})).json();
    const before = JSON.stringify(await deliveries());

    await signInAs("owner-b@example.test");
    tgCalls = [];
    expect((await status(B)).res.status).toBe(404); // B's URL + A's ids → not found
    expect((await deliveryRoute.GET(new Request("http://itest.local/?pollId=poll-a&teamGenerationId=gen-a"), p(A))).status).toBe(404);
    expect((await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId }), p(B))).status).toBe(404);
    expect((await deliveryRoute.POST(json("POST", { action: "mark_sent", deliveryId }), p(A))).status).toBe(404);
    expect((await post({ intent: "retry_uncertain", deliveryId }, B)).status).toBe(404);
    expect(tgCalls).toEqual([]);
    expect(JSON.stringify(await deliveries())).toBe(before);
  });
});

// ============================================================ links per visibility
describe("player-facing link in the teams message", () => {
  it("PRIVATE: never a URL, even when one is supplied", async () => {
    await prisma.group.update({ where: { id: "ga" }, data: { visibility: "PRIVATE" } });
    await post({ shareUrl: `${BASE}/share#${"A".repeat(43)}` });
    expect(String(sends()[0].body.text)).toBe(formatTeamsHtml("10/5/26", TEAMS));
  });

  it("LINK: no link supplied → sent without a URL; an active link of THIS Group → included; foreign/revoked → refused", async () => {
    await prisma.group.update({ where: { id: "ga" }, data: { visibility: "LINK" } });
    const tokenA = generateToken();
    const tokenB = generateToken();
    await prisma.groupShareLink.create({ data: { groupId: "ga", tokenHash: hashToken(tokenA) } });
    await prisma.groupShareLink.create({ data: { groupId: "gb", tokenHash: hashToken(tokenB) } });

    expect((await post({ shareUrl: `${BASE}/share#${tokenB}` })).status).toBe(400);
    expect((await post({ shareUrl: `https://evil.example/share#${tokenA}` })).status).toBe(400);
    expect(tgCalls).toEqual([]);

    await post({ shareUrl: `${BASE}/share#${tokenA}` });
    expect(String(sends()[0].body.text)).toContain(`<a href="${BASE}/share#${tokenA}">View teams online</a>`);
    const stored = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "MessageDelivery"`));
    expect(stored).not.toContain(tokenA);
    expect(stored).not.toContain("/share");

    await seed();
    await signInAs("owner-a@example.test");
    tgCalls = [];
    await prisma.group.update({ where: { id: "ga" }, data: { visibility: "LINK" } });
    await prisma.groupShareLink.create({ data: { groupId: "ga", tokenHash: hashToken(tokenA), revokedAt: new Date() } });
    expect((await post({ shareUrl: `${BASE}/share#${tokenA}` })).status).toBe(400);
    expect((await post({})).status).toBe(200);
    expect(String(sends()[0].body.text)).toBe(formatTeamsHtml("10/5/26", TEAMS));
  });
});

// ============================================================ Monday workflow end to end
describe("Monday workflow (PUBLIC Group) end to end", () => {
  it("create poll → votes → import → link a voter → generate → publish → close & post (no extra steps)", async () => {
    const created = await createPollRoute.POST(json("POST", { chatId: "1001", pollDate: "2026-10-12" }), p(A));
    expect(created.status).toBe(200);
    expect(tgCalls[0]).toMatchObject({ method: "sendPoll", body: { chat_id: "1001", question: "Who is playing on 10/12/26?", options: ["✅ Playing", "❌ Not playing"] } });

    await prisma.telegramPollAnswer.createMany({
      data: [
        { pollId: "tg-poll-new", userId: 11n, optionIdsJson: "[0]", groupId: "ga", firstName: "Doni" },
        { pollId: "tg-poll-new", userId: 12n, optionIdsJson: "[0]", groupId: "ga", firstName: "Eli" },
        { pollId: "tg-poll-new", userId: 13n, optionIdsJson: "[1]", groupId: "ga" },
      ],
    });
    await prisma.telegramUserLink.create({ data: { userId: 11n, playerId: "a1", groupId: "ga" } });

    let imported = await (await importRoute.POST(json("POST", { pollId: "tg-poll-new" }), p(A))).json();
    expect(imported).toMatchObject({ ok: true, selectedPlayerIds: ["a1"], missingUserIds: ["12"] });
    const unlinked = await (await usersRoute.GET(new Request("http://itest.local/"), p(A))).json();
    expect(unlinked.map((u: { userId: string }) => u.userId).sort()).toEqual(["12", "13"]);

    // create a Player, then link the voter to it (create-and-link)
    const createdPlayer = await (await playersRoute.POST(json("POST", { firstName: "Eli", lastName: "New", position: "FORWARD", rating: "GOOD" }), p(A))).json();
    expect((await linkRoute.POST(json("POST", { userId: "12", playerId: createdPlayer.id }), p(A))).status).toBe(200);
    imported = await (await importRoute.POST(json("POST", { pollId: "tg-poll-new" }), p(A))).json();
    expect([...imported.selectedPlayerIds].sort()).toEqual(["a1", createdPlayer.id].sort());

    const preview = await (await generateRoute.POST(json("POST", { teamCount: 2, date: "2026-10-12", selectedIds: imported.selectedPlayerIds }), p(A))).json();
    expect(preview.teams).toHaveLength(2);
    const published = await (await publishRoute.POST(json("POST", { date: "2026-10-12", teams: preview.teams }), p(A))).json();
    expect(typeof published.id).toBe("string");

    tgCalls = [];
    const res = await closePostRoute.POST(json("POST", { pollId: "tg-poll-new", teamGenerationId: published.id }), p(A));
    expect(await res.json()).toMatchObject({ ok: true, status: "posted", closeStatus: "closed_now" });
    expect(tgCalls.map((c) => c.method)).toEqual(["stopPoll", "sendMessage"]);
    expect(String(sends()[0].body.text)).toContain(`${BASE}/g/org-a/group-a`);
  });
});

describe("network safety", () => {
  it("no non-Telegram network call; Telegram itself was only ever the in-process stub", () => {
    expect(otherNetworkCalls).toBe(0);
  });
});
