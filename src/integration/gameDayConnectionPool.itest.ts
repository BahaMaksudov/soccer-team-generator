/**
 * Regression — Game Day Update under a SMALL connection pool (3 connections).
 * Before the fix, the sender holding the per-match lock read the Group settings
 * through the global Prisma client, i.e. it needed a SECOND connection while
 * concurrent senders (waiting on the same lock) held the rest of the pool:
 * "Timed out fetching a new connection from the connection pool" → nothing sent.
 * Every read inside the lock must use the transaction's own connection.
 *
 * REAL DATABASE (guarded local test DB only); Telegram is FAKE (captured,
 * answered by the test); no weather provider; nothing leaves the machine.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

// This file's app code uses a Prisma client limited to 3 connections (5 s pool timeout).
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const base = process.env.DATABASE_URL!;
  const url = `${base}${base.includes("?") ? "&" : "?"}connection_limit=3&pool_timeout=5`;
  return { prisma: new PrismaClient({ datasources: { db: { url } } }) };
});

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as previewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/game-day-update/preview/route";
import * as sendRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/game-day-update/send/route";
import { runMatchAutomation } from "@/lib/matchAutomation";
import { resetGameDayPreviewLimitForTests } from "@/lib/gameDayManual";
import { setWeatherProviderForTests } from "@/lib/weather";
import { zonedToUtc } from "@/lib/scheduleTime";
import type { GameDayPreview } from "@/lib/gameDayUpdate";

const TZ = "America/New_York";
const H = 3600_000;
const D = zonedToUtc("2099-06-03", "17:00", TZ);
const at = (ms: number) => new Date(D.getTime() + ms);
const CHAT = -100n;

let calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let otherNetwork = 0;
let seq = 1000;
const originalFetch = global.fetch;
async function fakeFetch(url: unknown, init?: { body?: string }): Promise<Response> {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/bot")) {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }
  calls.push({ method: u.split("/").pop()!, body: JSON.parse(init?.body ?? "{}") });
  // A slow Telegram (holds the race window open longer).
  await new Promise((r) => setTimeout(r, 50));
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++seq } }) } as unknown as Response;
}
const sends = () => calls.filter((c) => c.method === "sendMessage");
const deliveries = () => prisma.messageDelivery.findMany({ where: { matchId: "m", eventType: "GAME_DAY_UPDATE_POSTED" } });
const ctx = () => ({ params: Promise.resolve({ organizationSlug: "o", groupSlug: "o-g", matchId: "m" }) });
const preview = async () => ((await (await previewRoute.POST(new Request("http://itest.local/", { method: "POST" }), ctx())).json()) as { preview: GameDayPreview }).preview;
const send = async (token: string | null) => {
  const r = await sendRoute.POST(new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }), ctx());
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { result?: string } };
};

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = fakeFetch as typeof fetch;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("APP_BASE_URL", "https://tbp.itest");
  vi.stubEnv("NEXTAUTH_SECRET", "pool-itest-secret-0123456789abcdef");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  setWeatherProviderForTests(null);
  vi.stubEnv("WEATHERAPI_KEY", "");
});
beforeEach(async () => {
  calls = [];
  otherNetwork = 0;
  resetGameDayPreviewLimitForTests();
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.create({ data: { id: "u-owner", email: "owner@example.test", name: "owner", passwordHash: null, emailVerifiedAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.organization.create({ data: { id: "o", name: "Org o", slug: "o", plan: "LEGACY" } });
  await prisma.group.create({ data: { id: "o-g", organizationId: "o", name: "Indoor Soccer", slug: "o-g", sportKey: "soccer", timezone: TZ, visibility: "PRIVATE" } });
  await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: "o", role: "OWNER" } });
  await prisma.groupSetting.create({ data: { groupId: "o-g", key: "gameDayUpdate", value: JSON.stringify({ enabled: true, hoursBefore: 4, includeWeather: false, units: "imperial" }) } });
  const chat = await prisma.telegramChat.create({ data: { chatId: CHAT, title: "FunnyStuff", groupId: "o-g" } });
  await prisma.match.create({ data: { id: "m", groupId: "o-g", date: new Date("2099-06-03T00:00:00Z"), startTime: "21:00", telegramChatId: chat.id, attendanceDeadlineAt: D } });
  await prisma.telegramPoll.create({ data: { pollId: "poll-m", chatId: CHAT, messageId: 77n, question: "Q", optionsJson: "[]", groupId: "o-g", matchId: "m", kind: "ATTENDANCE", createdAt: at(-24 * H) } });
  session = { user: { id: "u-owner", email: "owner@example.test" } };
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("Game Day Update with a 3-connection pool (regression: no pool-starvation deadlock)", () => {
  it("8 concurrent automation runs (more than the pool) → exactly one message, one SENT record, no errors", async () => {
    const t = at(-3 * H);
    const runs = await Promise.all(Array.from({ length: 8 }, () => runMatchAutomation(t, { groupId: "o-g", matchId: "m" })));
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    expect(runs.reduce((n, r) => n + r.gameDayUpdates, 0)).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toMatchObject({ chat_id: CHAT.toString(), reply_parameters: { message_id: 77, allow_sending_without_reply: false } });
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", attempts: 1 })]);
    expect(otherNetwork).toBe(0);
  });

  it("concurrent manual sends (same confirmation) racing automation runs → exactly one message, one SENT record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(-3 * H));
    const p = await preview();
    expect(p.state).toBe("READY");
    const [manual, auto] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => send(p.token))),
      Promise.all(Array.from({ length: 3 }, () => runMatchAutomation(at(-3 * H), { groupId: "o-g", matchId: "m" }))),
    ]);
    expect(manual.every((r) => r.status !== 500)).toBe(true);
    expect(auto.flatMap((r) => r.errors)).toEqual([]);
    const sentCount = manual.filter((r) => r.body.result === "sent").length + auto.reduce((n, r) => n + r.gameDayUpdates, 0);
    expect(sentCount).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "SENT", attempts: 1 })]);
  });
});
