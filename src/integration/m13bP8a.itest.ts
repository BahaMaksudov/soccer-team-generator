/**
 * M13B P8A — the default-off LIVE pilot transport, exercised end-to-end with a MOCKED Resend
 * API: global fetch is replaced by a fake that only answers RESEND_ENDPOINT and records the
 * request; any other URL counts as forbidden network access. No real network, no real key
 * (the "API key" is a fake string), no real email. REAL DATABASE (guarded local test DB).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { createRsvpSend, processRsvpQueue, rsvpDeliveryMode, setRsvpTransportForTests } from "@/lib/rsvpSend";
import { rsvpAllowance } from "@/lib/rsvpPreview";
import { RSVP_PILOT_LIMITS } from "@/lib/rsvpDeliveryMode";
import { RESEND_ENDPOINT, testOutbox } from "@/lib/email/transport";
import { sendPasswordResetEmail } from "@/lib/email";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const AUTH_AT = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
const PILOT = "cm3pilotorg00000000000001";
const PILOT2 = "cm3pilotorg00000000000002";
const OTHER = "cm3otherorg00000000000001";
const FROM = "TeamBalance Pro <noreply@mail.teambalancepro.com>";
const LIVE: Record<string, string> = {
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  RSVP_EMAIL_DELIVERY: "live-pilot",
  RSVP_EMAIL_PILOT_ORGS: `${PILOT},${PILOT2}`,
  RESEND_API_KEY: "re_fake_itest_key",
  EMAIL_FROM: FROM,
  APP_BASE_URL: "https://teambalancepro.com",
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let forbidden = 0;
let respond: (n: number) => Promise<Response> | Response = (n) => new Response(JSON.stringify({ id: `re_${n}` }), { status: 200 });
const originalFetch = global.fetch;

const ctx = (organizationId: string, groupId: string): TenantContext => {
  const group = { id: groupId, name: groupId, slug: groupId, sportKey: "soccer", timezone: TZ };
  return { user: { id: "u-owner", email: "owner@example.test", name: "o" }, organization: { id: organizationId, name: organizationId, slug: organizationId }, membership: { id: "m", role: "OWNER" }, groups: [group], activeGroup: group };
};
let keyN = 0;
const send = (orgId: string, groupId: string, matchId: string) => createRsvpSend(ctx(orgId, groupId), matchId, { kind: "INITIAL", requestKey: `key-p8a-${String(++keyN).padStart(6, "0")}` });
const live = (extra: Record<string, string | undefined> = {}) => {
  for (const [k, v] of Object.entries({ ...LIVE, ...extra })) vi.stubEnv(k, v as string);
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EmailWebhookEvent","RsvpEmailUsage","RsvpInvitation","RsvpSend","EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PersonalAttendanceLink","AttendanceResponse","Match","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.create({ data: { id: "u-owner", email: "owner@example.test", name: "owner", passwordHash: null, emailVerifiedAt: VERIFIED } });
  await prisma.organization.createMany({
    data: [
      { id: PILOT, name: "Pilot Club", slug: "pilot", plan: "LEGACY" },
      { id: PILOT2, name: "Pilot Two", slug: "pilot2", plan: "LEGACY" },
      { id: OTHER, name: "Other Club", slug: "other", plan: "LEGACY" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "gp", organizationId: PILOT, name: "Pilot group", slug: "gp", sportKey: "soccer", timezone: TZ },
      { id: "gp2", organizationId: PILOT2, name: "Pilot two group", slug: "gp2", sportKey: "soccer", timezone: TZ },
      { id: "go", organizationId: OTHER, name: "Other group", slug: "go", sportKey: "soccer", timezone: TZ },
    ],
  });
  const players = (groupId: string, prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(2, "0")}`, groupId, firstName: `${prefix.toUpperCase()}${String(i).padStart(2, "0")}`, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail: `${prefix}${i}@example.com`, contactEmailType: "PLAYER" as const, contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-owner" }));
  await prisma.player.createMany({ data: [...players("gp", "p", 3), ...players("gp2", "t", 25), ...players("go", "o", 2)] });
  await prisma.match.createMany({ data: [{ id: "mp", groupId: "gp", date: new Date("2099-06-03") }, { id: "mp2", groupId: "gp2", date: new Date("2099-06-03") }, { id: "mo", groupId: "go", date: new Date("2099-06-03") }] });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  // A FAKE Resend API: only RESEND_ENDPOINT answers; everything else is forbidden network access.
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== RESEND_ENDPOINT) {
      forbidden++;
      throw new Error("network access is forbidden in integration tests");
    }
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return respond(calls.length);
  }) as typeof fetch;
});
beforeEach(async () => {
  calls = [];
  forbidden = 0;
  respond = (n) => new Response(JSON.stringify({ id: `re_${n}` }), { status: 200 });
  testOutbox.clear();
  setRsvpTransportForTests(null);
  await seed();
});
afterEach(() => {
  expect(forbidden, "no network access beyond the fake Resend").toBe(0);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setRsvpTransportForTests(null);
});
afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
});

describe("M13B P8A — live pilot transport (mocked Resend)", () => {
  it("default: nothing is live in tests, and nothing reaches Resend", async () => {
    vi.stubEnv("APP_BASE_URL", "http://itest.local");
    vi.stubEnv("EMAIL_FROM", FROM);
    vi.stubEnv("RESEND_API_KEY", "re_fake_itest_key"); // present, but alone it changes nothing
    expect(rsvpDeliveryMode()).toBe("test-outbox");
    expect(await send(PILOT, "gp", "mp")).toMatchObject({ ok: true });
    await processRsvpQueue();
    expect(calls).toHaveLength(0);
    expect(testOutbox.sent).toHaveLength(3);
  });

  it("allowlisted organization: sent through the Resend API with the idempotency key and unsubscribe headers", async () => {
    live();
    expect(rsvpDeliveryMode()).toBe("live");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await send(PILOT, "gp", "mp");
    expect(r).toMatchObject({ ok: true, counts: { queued: 3 } });
    expect(await processRsvpQueue()).toMatchObject({ sent: 3, failed: 0, uncertain: 0 });
    expect(testOutbox.sent).toHaveLength(0);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.headers).toMatchObject({ Authorization: "Bearer re_fake_itest_key", "Content-Type": "application/json", "Idempotency-Key": expect.stringMatching(/^rsvp:[a-z0-9]+:1$/) });
      expect(c.body.from).toBe(FROM);
      expect(c.body.to).toEqual([expect.stringMatching(/^p\d@example\.com$/)]);
      expect(c.body.headers).toEqual({ "List-Unsubscribe": expect.stringMatching(/^<https:\/\/teambalancepro\.com\/api\/email\/unsubscribe\/one-click\?t=[A-Za-z0-9_-]+>$/), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(String(c.body.text)).toMatch(/https:\/\/teambalancepro\.com\/attend\?c=yes#/);
    }
    expect((await prisma.rsvpInvitation.findMany({ select: { status: true, providerMessageId: true } })).map((i) => i.status)).toEqual(["SENT", "SENT", "SENT"]);
  });

  it("a non-allowlisted organization can't queue, and its queued rows are never claimed while live", async () => {
    expect(await send(OTHER, "go", "mo")).toMatchObject({ ok: true }); // queued while in test mode
    live();
    expect(await send(OTHER, "go", "mo")).toEqual({ ok: false, code: "DELIVERY_DISABLED" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await send(PILOT, "gp", "mp")).toMatchObject({ ok: true });
    const run = await processRsvpQueue({ limit: 50 });
    expect(run).toMatchObject({ sent: 3, remaining: 0 });
    expect(await prisma.rsvpInvitation.count({ where: { organizationId: OTHER, status: "QUEUED" } })).toBe(2);
    expect(calls.every((c) => (c.body.to as string[])[0].startsWith("p"))).toBe(true);
  });

  it("Preview, development and incomplete configurations refuse: nothing is queued, claimed or sent", async () => {
    expect(await send(PILOT, "gp", "mp")).toMatchObject({ ok: true }); // queued in test mode
    for (const extra of [{ VERCEL_ENV: "preview" }, { NODE_ENV: "development" }, { RSVP_EMAIL_DELIVERY: "true" }, { RSVP_EMAIL_PILOT_ORGS: "" }, { EMAIL_FROM: "TeamBalance Pro <noreply@teambalancepro.com>" }, { RESEND_API_KEY: "" }]) {
      live(extra);
      expect(rsvpDeliveryMode(), JSON.stringify(extra)).toBe("disabled");
      expect(await send(PILOT, "gp", "mp")).toEqual({ ok: false, code: "DELIVERY_DISABLED" });
      await expect(processRsvpQueue()).rejects.toThrow(/not available/);
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(0);
    expect(await prisma.rsvpInvitation.count({ where: { status: "QUEUED" } })).toBe(3);
  });

  it("pilot limits: the stricter of plan and pilot per organization, and one pilot-wide daily cap", async () => {
    live();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const a = await rsvpAllowance(PILOT2);
    expect(a.day.limit).toBe(Math.min(50, RSVP_PILOT_LIMITS.perOrganizationDay));
    expect(a.month.limit).toBe(Math.min(500, RSVP_PILOT_LIMITS.perOrganizationMonth));
    expect(await send(PILOT2, "gp2", "mp2")).toMatchObject({ ok: true, counts: { queued: 20, byReason: { LIMIT: 5 } } });
    // The pilot-wide cap: 100 per UTC day across organizations (20 reserved here + 77 consumed elsewhere → 3 left).
    const today = new Date().toISOString().slice(0, 10);
    await prisma.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES (${OTHER}, ${today}::date, 77)`;
    expect(await send(PILOT, "gp", "mp")).toMatchObject({ ok: true, counts: { queued: 3 } });
    await prisma.$executeRaw`UPDATE "RsvpEmailUsage" SET "consumed" = 78 WHERE "organizationId" = ${OTHER}`;
    await prisma.match.create({ data: { id: "mp-b", groupId: "gp", date: new Date("2099-06-10") } });
    expect(await send(PILOT, "gp", "mp-b")).toEqual({ ok: false, code: "PLAN_LIMIT" }); // 78 + 23 reserved ≥ 100
  });

  it("provider outcomes: definite rejections are FAILED (released), everything ambiguous is UNCERTAIN; nothing logged with an address", async () => {
    live();
    const logs: string[] = [];
    for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    await prisma.player.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({ id: `px${i}`, groupId: "gp", firstName: `PX${i}`, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail: `px${i}@example.com`, contactEmailType: "PLAYER" as const, contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-owner" })),
    });
    const outcomes: Array<() => Promise<Response> | Response> = [
      () => new Response("{}", { status: 422 }),
      () => new Response("{}", { status: 429 }),
      () => new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 409 }),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    ];
    respond = (n) => outcomes[n - 1]();
    expect(await send(PILOT, "gp", "mp")).toMatchObject({ ok: true, counts: { queued: 6 } });
    expect(await processRsvpQueue()).toMatchObject({ sent: 0, failed: 2, uncertain: 4 });
    const rows = await prisma.rsvpInvitation.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { status: true, lastError: true } });
    expect(rows.map((r) => `${r.status}:${r.lastError}`).sort()).toEqual(["FAILED:HTTP_422", "FAILED:HTTP_429", "UNCERTAIN:HTTP_409", "UNCERTAIN:HTTP_500", "UNCERTAIN:NETWORK", "UNCERTAIN:TIMEOUT"]);
    expect((await rsvpAllowance(PILOT)).day.used).toBe(4); // failed released, uncertain counted
    expect(logs.join("\n")).not.toMatch(/@example\.com|re_fake_itest_key|t=[A-Za-z0-9_-]{20,}/);
  });

  it("concurrent workers: every invitation is POSTed exactly once", async () => {
    live();
    vi.spyOn(console, "info").mockImplementation(() => {});
    await send(PILOT2, "gp2", "mp2"); // 20 queued (pilot limit)
    const runs = await Promise.all([processRsvpQueue({ limit: 50 }), processRsvpQueue({ limit: 50 }), processRsvpQueue({ limit: 50 })]);
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(20);
    expect(calls).toHaveLength(20);
    expect(new Set(calls.map((c) => c.headers["Idempotency-Key"])).size).toBe(20);
    expect(new Set(calls.map((c) => (c.body.to as string[])[0])).size).toBe(20);
  });

  it("account / security email is independent: it never carries unsubscribe headers and isn't blocked by RSVP limits or suppression", async () => {
    live();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const today = new Date().toISOString().slice(0, 10);
    await prisma.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES (${OTHER}, ${today}::date, 1000)`; // pilot cap exhausted
    await prisma.globalEmailSuppression.create({ data: { email: "owner@example.test", reason: "HARD_BOUNCE", source: "test" } });
    await sendPasswordResetEmail({ to: "owner@example.test", name: "Owner", token: "tok", expiresAt: new Date(Date.now() + 3_600_000) });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.to).toEqual(["owner@example.test"]);
    expect(calls[0].body.headers).toBeUndefined();
    expect(String(calls[0].body.text)).not.toMatch(/unsubscribe/i);
  });
});
