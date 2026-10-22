/**
 * M13B P4 — the RSVP email sending engine. REAL DATABASE (guarded local test DB only).
 * Delivery goes to the in-memory test outbox (or a fake transport) ONLY; network is
 * forbidden (global fetch throws and is counted); no Telegram, no Resend.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { createRsvpSend, processRsvpQueue, retryFailedInvitations, setRsvpTransportForTests, RsvpDeliveryDisabledError, RSVP_STALE_SENDING_MS } from "@/lib/rsvpSend";
import { rsvpAllowance } from "@/lib/rsvpPreview";
import { answerPersonal, issuePersonalLinks, personalView } from "@/lib/personalAttendance";
import { confirmUnsubscribe, recordGlobalSuppression } from "@/lib/emailSuppression";
import { createResendTransport, EmailDeliveryError, RESEND_ENDPOINT, testOutbox, type EmailTransport } from "@/lib/email/transport";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
const NOW = new Date("2026-10-21T15:00:00Z");
let network = 0;
const originalFetch = global.fetch;

type Role = "OWNER" | "ADMIN" | "MEMBER";
const ctx = (userId: string, organizationId: string, groupId: string, role: Role = "OWNER"): TenantContext => {
  const group = { id: groupId, name: groupId, slug: groupId, sportKey: "soccer", timezone: TZ };
  return { user: { id: userId, email: `${userId}@example.test`, name: userId }, organization: { id: organizationId, name: organizationId, slug: organizationId }, membership: { id: `mem-${userId}`, role }, groups: [group], activeGroup: group };
};
const OWNER = () => ctx("u-owner", "o", "g");
const ADMIN = () => ctx("u-admin", "o", "g", "ADMIN");
const FREE = () => ctx("u-free", "of", "gf");
const send = (c: TenantContext, matchId: string, requestKey: string, kind: "INITIAL" | "RESEND" = "INITIAL", now = NOW) => createRsvpSend(c, matchId, { kind, requestKey }, now);
const invitations = (where: Record<string, unknown> = {}) => prisma.rsvpInvitation.findMany({ where, orderBy: [{ round: "asc" }, { playerId: "asc" }] });
const byPlayer = async (sendId: string) => Object.fromEntries((await invitations({ sendId })).map((i) => [i.playerId, { status: i.status, skipReason: i.skipReason }]));
const answerToken = (text: string) => /Answer: \S+#(\S+)/.exec(text)![1];
const oneClickToken = (headers: Record<string, string> | undefined) => decodeURIComponent(/\?t=([^>]+)>/.exec(headers!["List-Unsubscribe"])![1]);
const mailTo = (to: string) => testOutbox.sent.filter((m) => m.to === to);
const failing = (make: () => Error): EmailTransport => ({ name: "failing", send: async () => Promise.reject(make()) });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "RsvpEmailUsage","RsvpInvitation","RsvpSend","EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PersonalAttendanceLink","AttendanceResponse","TelegramPoll","TelegramChat","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other", "free", "linked"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({
    data: [
      { id: "o", name: "Wednesday Club", slug: "o", plan: "LEGACY" },
      { id: "o2", name: "Other Club", slug: "o2", plan: "LEGACY" },
      { id: "of", name: "Free Club", slug: "of", plan: "FREE" },
    ],
  });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday", slug: "g", sportKey: "soccer", timezone: TZ },
      { id: "gx", organizationId: "o", name: "Second", slug: "gx", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other", slug: "g2", sportKey: "soccer", timezone: TZ },
      { id: "gf", organizationId: "of", name: "Free group", slug: "gf", sportKey: "soccer", timezone: TZ },
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
  const P = (id: string, groupId: string, firstName: string, extra: Record<string, unknown> = {}) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, ...extra });
  await prisma.player.createMany({
    data: [
      P("p1", "g", "Ava", { contactEmail: "guardian.of.ava@example.com", contactEmailType: "GUARDIAN" }),
      P("p2", "g", "Ben", { contactEmail: "ben@example.com", contactEmailType: "PLAYER" }),
      P("p3", "g", "Cal", { userId: "u-linked" }), // verified linked account
      P("p4", "g", "Dee"), // no email
      P("p5", "g", "Eve", { contactEmail: "eve@example.com", contactEmailType: "PLAYER" }), // opted out of o
      P("p6", "g", "Fay", { contactEmail: "fay@example.com", contactEmailType: "PLAYER" }), // answered
      P("p7", "g", "Gus", { contactEmail: "gus@example.com", contactEmailType: "PLAYER" }), // organizer override
      P("q1", "g2", "Quinn", { contactEmail: "ben@example.com", contactEmailType: "PLAYER" }), // same address, other organization
      ...Array.from({ length: 22 }, (_, i) => P(`f${String(i).padStart(2, "0")}`, "gf", `F${String(i).padStart(2, "0")}`, { contactEmail: `f${i}@example.com`, contactEmailType: "PLAYER" })),
    ],
  });
  await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "eve@example.com", source: "LINK" } });
  await prisma.match.createMany({
    data: [
      { id: "m", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", locationName: "Field 2" },
      { id: "mb", groupId: "g", date: new Date("2099-06-10") },
      { id: "m2", groupId: "g2", date: new Date("2099-06-03") },
      ...["mf", "mf2", "mf3", "mf4", "mf5"].map((id) => ({ id, groupId: "gf", date: new Date("2099-06-03") })),
    ],
  });
  await prisma.attendanceResponse.createMany({
    data: [
      { matchId: "m", groupId: "g", playerId: "p6", participantStatus: "MAYBE", participantSource: "PERSONAL_LINK", participantRespondedAt: NOW },
      { matchId: "m", groupId: "g", playerId: "p7", overrideStatus: "NOT_PLAYING", overrideAt: NOW, overrideByUserId: "u-owner" },
    ],
  });
}

/** Simulate earlier ledger usage: n invitations of an old send of organization `of`. */
async function fillLedger(n: number, status: "SENT" | "UNCERTAIN" | "FAILED" | "SKIPPED", reservedAt: Date) {
  const matchId = `fill-${status}-${reservedAt.getTime()}`;
  await prisma.match.create({ data: { id: matchId, groupId: "gf", date: new Date("2099-01-01") } });
  const s = await prisma.rsvpSend.create({ data: { organizationId: "of", groupId: "gf", matchId, kind: "INITIAL", round: 1, requestKey: `fill-${matchId}` } });
  await prisma.rsvpInvitation.createMany({ data: Array.from({ length: n }, () => ({ sendId: s.id, organizationId: "of", groupId: "gf", matchId, round: 1, status, reservedAt })) });
  // The engine moves SENT / UNCERTAIN rows to the durable ledger; mirror that here.
  if (status === "SENT" || status === "UNCERTAIN")
    await prisma.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES ('of', ${reservedAt.toISOString().slice(0, 10)}::date, ${n})
      ON CONFLICT ("organizationId", "day") DO UPDATE SET "consumed" = "RsvpEmailUsage"."consumed" + ${n}`;
}

/** The ledger never double-counts: consumed == SENT + UNCERTAIN invitations (when none were deleted). */
async function ledgerMatchesInvitations(organizationId: string) {
  const [{ consumed }] = await prisma.$queryRaw<Array<{ consumed: bigint }>>`SELECT COALESCE(SUM("consumed"), 0)::bigint AS consumed FROM "RsvpEmailUsage" WHERE "organizationId" = ${organizationId}`;
  expect(Number(consumed)).toBe(await prisma.rsvpInvitation.count({ where: { organizationId, status: { in: ["SENT", "UNCERTAIN"] } } }));
}

/** Every text value in every table, to prove a raw token is stored nowhere. */
async function databaseContains(needle: string): Promise<string[]> {
  const tables = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const hits: string[] = [];
  for (const { t } of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}" x WHERE row_to_json(x)::text LIKE $1`, `%${needle}%`);
    if (Number(n) > 0) hits.push(t);
  }
  return hits;
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    network++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});
beforeEach(async () => {
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@tbp.itest>");
  network = 0;
  testOutbox.clear();
  setRsvpTransportForTests(null);
  await seed();
});
afterEach(() => {
  expect(network, "no network access").toBe(0);
  vi.unstubAllEnvs();
  setRsvpTransportForTests(null);
});
afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
});

describe("M13B P4 — queue and deliver (test outbox only)", () => {
  it("queues eligible players, skips the rest with reasons; queuing sends nothing and creates no links or tokens", async () => {
    const r = await send(OWNER(), "m", "key-initial-0001");
    expect(r).toMatchObject({ ok: true, round: 1, duplicate: false, counts: { queued: 3, skipped: 4, byReason: { NO_EMAIL: 1, SUPPRESSED: 1, ALREADY_ANSWERED: 1, ORGANIZER_OVERRIDE: 1 } } });
    if (!r.ok) throw new Error();
    expect(await byPlayer(r.sendId)).toEqual({
      p1: { status: "QUEUED", skipReason: null },
      p2: { status: "QUEUED", skipReason: null },
      p3: { status: "QUEUED", skipReason: null },
      p4: { status: "SKIPPED", skipReason: "NO_EMAIL" },
      p5: { status: "SKIPPED", skipReason: "SUPPRESSED" },
      p6: { status: "SKIPPED", skipReason: "ALREADY_ANSWERED" },
      p7: { status: "SKIPPED", skipReason: "ORGANIZER_OVERRIDE" },
    });
    expect(testOutbox.sent).toHaveLength(0);
    expect(await prisma.personalAttendanceLink.count()).toBe(0);
    expect(await prisma.emailUnsubscribeToken.count()).toBe(0);
    const a = await rsvpAllowance("o", NOW);
    expect(a.day).toMatchObject({ limit: 50, used: 3, reserved: 3, remaining: 47 });
    expect(a.month).toMatchObject({ limit: 500, used: 3, reserved: 3, remaining: 497 });
  });

  it("the worker delivers each queued invitation once: headers, idempotency key, guardian wording, hash-only tokens", async () => {
    const r = await send(OWNER(), "m", "key-initial-0002");
    if (!r.ok) throw new Error();
    const run = await processRsvpQueue({ sendId: r.sendId, now: NOW });
    expect(run).toMatchObject({ recovered: 0, sent: 3, failed: 0, uncertain: 0, skipped: 0, remaining: 0 });
    expect(testOutbox.sent.map((m) => m.to).sort()).toEqual(["ben@example.com", "guardian.of.ava@example.com", "linked@example.test"]);
    const rows = await invitations({ sendId: r.sendId, status: "SENT" });
    expect(rows).toHaveLength(3);
    for (const inv of rows) {
      expect(inv).toMatchObject({ attempts: 1, idempotencyKey: `rsvp:${inv.id}:1`, lastError: null });
      expect(inv.providerMessageId).toMatch(/^memory-/);
      expect(inv.linkId && inv.unsubscribeTokenId).toBeTruthy();
    }
    expect(await prisma.personalAttendanceLink.findMany({ select: { channel: true, revokedAt: true } })).toEqual(Array(3).fill({ channel: "EMAIL", revokedAt: null }));
    for (const m of testOutbox.sent) {
      expect(m.from).toBe("TeamBalance Pro <no-reply@tbp.itest>");
      expect(m.idempotencyKey).toMatch(/^rsvp:[a-z0-9]+:1$/);
      expect(m.headers).toEqual({ "List-Unsubscribe": expect.stringMatching(/^<http:\/\/itest\.local\/api\/email\/unsubscribe\/one-click\?t=[A-Za-z0-9_-]+>$/), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(m.text).toMatch(/Stop match invitation emails from Wednesday Club: http:\/\/itest\.local\/unsubscribe#/);
      // Neither raw token is stored anywhere.
      expect(await databaseContains(answerToken(m.text))).toEqual([]);
      expect(await databaseContains(oneClickToken(m.headers))).toEqual([]);
    }
    const [guardian] = mailTo("guardian.of.ava@example.com");
    expect(guardian.subject).toMatch(/^Is Ava Test playing\? Wednesday/);
    expect(guardian.text).toContain("parent / guardian contact for Ava Test");
    // Only the player's own name: no other player's data in any email.
    for (const m of testOutbox.sent) for (const other of ["Dee", "Eve", "Fay", "Gus"]) expect(m.text).not.toContain(other);
    // A second run sends nothing more (no duplicates).
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 0, remaining: 0 });
    expect(testOutbox.sent).toHaveLength(3);
    expect((await rsvpAllowance("o", NOW)).day).toMatchObject({ used: 3, reserved: 0, remaining: 47 });
  });

  it("attendance semantics are unchanged: sending answers nothing; the emailed link answers as PERSONAL_LINK; one-click unsubscribes", async () => {
    const r = await send(OWNER(), "m", "key-initial-0003");
    if (!r.ok) throw new Error();
    await processRsvpQueue({ now: NOW });
    expect(await prisma.attendanceResponse.count({ where: { matchId: "m", playerId: { in: ["p1", "p2", "p3"] } } })).toBe(0);
    const [ben] = mailTo("ben@example.com");
    const token = answerToken(ben.text);
    expect((await personalView(token))?.state).toBe("open"); // opening never answers
    expect(await prisma.attendanceResponse.count({ where: { playerId: "p2" } })).toBe(0);
    expect(await answerPersonal(token, "PLAYING")).toMatchObject({ ok: true, status: "PLAYING", setByOrganizer: false });
    expect(await prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId: "m", playerId: "p2" } } })).toMatchObject({ participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", overrideStatus: null });
    expect(await confirmUnsubscribe(oneClickToken(ben.headers), "ONE_CLICK")).toEqual({ ok: true, alreadyUnsubscribed: false });
    expect(await prisma.organizationEmailOptOut.findFirst({ where: { organizationId: "o", email: "ben@example.com" } })).toMatchObject({ source: "ONE_CLICK" });
    // Another organization still reaches the same address.
    expect(await send(ctx("u-other", "o2", "g2"), "m2", "key-other-00001")).toMatchObject({ ok: true, counts: { queued: 1 } });
  });

  it("nothing is logged with an address or a token", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const r = await send(OWNER(), "m", "key-initial-0004");
    if (!r.ok) throw new Error();
    await processRsvpQueue({ now: NOW });
    setRsvpTransportForTests(failing(() => new EmailDeliveryError("http", 422)));
    await send(ctx("u-free", "of", "gf"), "mf", "key-free-log-001");
    await processRsvpQueue({ now: NOW });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toMatch(/@example\.(com|test)/);
    for (const m of testOutbox.sent) expect(logged).not.toContain(answerToken(m.text));
  });
});

describe("M13B P4 — idempotency and concurrency", () => {
  it("double-click: the same requestKey (even concurrently) creates one send", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => send(OWNER(), "m", "key-double-0001")));
    const ids = new Set(results.map((x) => (x.ok ? x.sendId : x.code)));
    expect(ids.size).toBe(1);
    expect(results.filter((x) => x.ok && !x.duplicate)).toHaveLength(1);
    expect(results.every((x) => x.ok && x.counts.queued === 3)).toBe(true);
    expect(await prisma.rsvpSend.count()).toBe(1);
    expect(await prisma.rsvpInvitation.count()).toBe(7);
    expect((await rsvpAllowance("o", NOW)).day.used).toBe(3);
    // The same key for a different match is refused; malformed keys and kinds are refused.
    expect(await send(OWNER(), "mb", "key-double-0001")).toEqual({ ok: false, code: "REQUEST_KEY_CONFLICT" });
    expect(await send(OWNER(), "mb", "short")).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await createRsvpSend(OWNER(), "mb", { kind: "BOGUS" as "INITIAL", requestKey: "key-bogus-00001" })).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("concurrent organizers: two INITIAL sends for one match → exactly one; RESEND needs an earlier send", async () => {
    const [a, b] = await Promise.all([send(OWNER(), "m", "key-owner-00001"), send(ADMIN(), "m", "key-admin-00001")]);
    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    expect([a, b].find((x) => !x.ok)).toEqual({ ok: false, code: "ALREADY_SENT" });
    expect(await prisma.rsvpSend.count()).toBe(1);
    expect(await send(OWNER(), "mb", "key-resend-0001", "RESEND")).toEqual({ ok: false, code: "NOTHING_TO_RESEND" });
    // An explicit RESEND is a new round for the still-unanswered players.
    const re = await send(ADMIN(), "m", "key-resend-0002", "RESEND");
    expect(re).toMatchObject({ ok: true, round: 2, counts: { queued: 3 } });
    expect((await rsvpAllowance("o", NOW)).day.used).toBe(6);
  });

  it("concurrent workers never claim the same invitation", async () => {
    await prisma.player.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, groupId: "gx", firstName: `W${String(i).padStart(2, "0")}`, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, contactEmail: `w${i}@example.com`, contactEmailType: "PLAYER" as const })) });
    await prisma.match.create({ data: { id: "mw", groupId: "gx", date: new Date("2099-06-03") } });
    const r = await send(ctx("u-owner", "o", "gx"), "mw", "key-workers-001");
    expect(r).toMatchObject({ ok: true, counts: { queued: 30 } });
    const runs = await Promise.all(Array.from({ length: 4 }, () => processRsvpQueue({ limit: 25, now: NOW })));
    expect(runs.reduce((n, x) => n + x.sent, 0)).toBe(30);
    expect(testOutbox.sent).toHaveLength(30);
    expect(new Set(testOutbox.sent.map((m) => m.to)).size).toBe(30);
    expect(new Set(testOutbox.sent.map((m) => m.idempotencyKey)).size).toBe(30);
    expect(await prisma.rsvpInvitation.count({ where: { matchId: "mw", status: "SENT", attempts: 1 } })).toBe(30);
  });
});

describe("M13B P4 — quota (UTC day / month)", () => {
  const LATE = new Date("2026-10-21T23:59:59Z");
  const NEXT_DAY = new Date("2026-10-22T00:00:00Z");

  it("Free: 20 per day; the rest are SKIPPED (LIMIT); a full day refuses further sends; the UTC day rolls over at 00:00Z", async () => {
    const r = await send(FREE(), "mf", "key-free-00001", "INITIAL", LATE);
    expect(r).toMatchObject({ ok: true, counts: { queued: 20, skipped: 2, byReason: { LIMIT: 2 } } });
    expect((await rsvpAllowance("of", LATE)).day).toMatchObject({ limit: 20, used: 20, reserved: 20, remaining: 0 });
    expect(await send(FREE(), "mf2", "key-free-00002", "INITIAL", LATE)).toEqual({ ok: false, code: "PLAN_LIMIT" });
    expect(await prisma.rsvpSend.count()).toBe(1);
    await processRsvpQueue({ now: LATE });
    expect((await rsvpAllowance("of", LATE)).day).toMatchObject({ used: 20, reserved: 0, remaining: 0 }); // sent stays consumed
    const next = await rsvpAllowance("of", NEXT_DAY);
    expect(next.day).toMatchObject({ used: 0, remaining: 20, period: "2026-10-22" });
    expect(next.month).toMatchObject({ used: 20, remaining: 80 });
    expect(await send(FREE(), "mf2", "key-free-00003", "INITIAL", NEXT_DAY)).toMatchObject({ ok: true, counts: { queued: 20 } });
  });

  it("concurrent sends for different matches never exceed the remaining allowance", async () => {
    const results = await Promise.all(["mf", "mf2", "mf3"].map((m, i) => send(FREE(), m, `key-conc-quota-${i}`)));
    const queued = results.reduce((n, x) => n + (x.ok ? x.counts.queued : 0), 0);
    expect(queued).toBe(20);
    expect(results.filter((x) => !x.ok).every((x) => !x.ok && x.code === "PLAN_LIMIT")).toBe(true);
    expect((await rsvpAllowance("of", NOW)).day.used).toBe(20);
  });

  it("monthly: 100 for Free counting SENT + UNCERTAIN + reserved; FAILED and SKIPPED don't count; the month rolls over at 00:00Z on the 1st", async () => {
    await fillLedger(60, "SENT", new Date("2026-10-01T00:00:00Z"));
    await fillLedger(35, "UNCERTAIN", new Date("2026-10-02T10:00:00Z"));
    await fillLedger(40, "FAILED", new Date("2026-10-03T10:00:00Z"));
    await fillLedger(40, "SKIPPED", new Date("2026-10-03T10:00:00Z"));
    await fillLedger(50, "SENT", new Date("2026-09-30T23:59:59Z")); // previous month
    expect((await rsvpAllowance("of", NOW)).month).toMatchObject({ limit: 100, used: 95, reserved: 0, remaining: 5 });
    expect(await send(FREE(), "mf", "key-month-00001")).toMatchObject({ ok: true, counts: { queued: 5, byReason: { LIMIT: 17 } } });
    expect(await send(FREE(), "mf2", "key-month-00002")).toEqual({ ok: false, code: "PLAN_LIMIT" });
    const nov = new Date("2026-11-01T00:00:00Z");
    expect((await rsvpAllowance("of", nov)).month).toMatchObject({ period: "2026-11", used: 0, remaining: 100 });
    expect(await send(FREE(), "mf2", "key-month-00003", "INITIAL", nov)).toMatchObject({ ok: true, counts: { queued: 20 } });
  });

  it("a trial keeps Free's RSVP limits; tenant ledgers are separate", async () => {
    await prisma.organization.update({ where: { id: "of" }, data: { trialStartedAt: NOW, trialEndsAt: new Date(NOW.getTime() + 30 * 86_400_000) } });
    expect(await send(FREE(), "mf", "key-trial-00001")).toMatchObject({ ok: true, counts: { queued: 20 } });
    expect((await rsvpAllowance("o", NOW)).day.used).toBe(0);
    expect((await rsvpAllowance("o2", NOW)).day.used).toBe(0);
  });
});

describe("M13B P4 hardening — durable quota history", () => {
  it("deleting a match after sending keeps the consumed allowance (no bypass by delete-and-resend)", async () => {
    expect(await send(FREE(), "mf", "key-del-match-01")).toMatchObject({ ok: true, counts: { queued: 20 } });
    await processRsvpQueue({ now: NOW });
    await ledgerMatchesInvitations("of");
    await prisma.match.delete({ where: { id: "mf" } });
    expect(await prisma.rsvpInvitation.count({ where: { organizationId: "of" } })).toBe(0); // invitation rows (with addresses) are gone
    expect((await rsvpAllowance("of", NOW)).day).toMatchObject({ used: 20, reserved: 0, remaining: 0 });
    expect((await rsvpAllowance("of", NOW)).month).toMatchObject({ used: 20, remaining: 80 });
    expect(await send(FREE(), "mf2", "key-del-match-02")).toEqual({ ok: false, code: "PLAN_LIMIT" });
    // The ledger holds no recipient data.
    const cols = await prisma.$queryRaw<Array<{ c: string }>>`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'RsvpEmailUsage' ORDER BY 1`;
    expect(cols.map((x) => x.c)).toEqual(["consumed", "day", "organizationId"]);
  });

  it("deleting a match with only QUEUED (never sent) invitations releases them", async () => {
    await send(FREE(), "mf", "key-del-queued-1");
    expect((await rsvpAllowance("of", NOW)).day.used).toBe(20);
    await prisma.match.delete({ where: { id: "mf" } });
    expect((await rsvpAllowance("of", NOW)).day).toMatchObject({ used: 0, remaining: 20 });
  });

  it("deleting a player keeps their consumed email counted", async () => {
    await send(FREE(), "mf", "key-del-player-1");
    await processRsvpQueue({ now: NOW });
    await prisma.player.deleteMany({ where: { id: { in: ["f00", "f01", "f02"] } } });
    expect((await rsvpAllowance("of", NOW)).day.used).toBe(20);
    await ledgerMatchesInvitations("of");
  });

  it("a match deleted while its email is being handed off is still counted", async () => {
    await send(FREE(), "mf", "key-del-midsend1");
    let first = true;
    setRsvpTransportForTests({
      name: "deleting",
      send: async () => {
        if (first) {
          first = false;
          await prisma.match.delete({ where: { id: "mf" } });
        }
        return { providerMessageId: "x" };
      },
    });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 1, errors: 0 });
    expect((await rsvpAllowance("of", NOW)).day).toMatchObject({ used: 1, reserved: 0 });
  });

  it("consumption counts on the UTC day of the reservation, even when sent after midnight; FAILED and SKIPPED never consume", async () => {
    const late = new Date("2026-10-21T23:59:59Z");
    const after = new Date("2026-10-22T00:00:30Z");
    await send(FREE(), "mf", "key-rollover-001", "INITIAL", late);
    let n = 0;
    setRsvpTransportForTests({ name: "mixed", send: async () => (++n % 4 === 0 ? Promise.reject(new EmailDeliveryError("http", 422)) : { providerMessageId: `m${n}` }) });
    await prisma.attendanceResponse.create({ data: { matchId: "mf", groupId: "gf", playerId: "f19", participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: late } });
    expect(await processRsvpQueue({ now: after })).toMatchObject({ sent: 15, failed: 4, skipped: 1 });
    expect((await rsvpAllowance("of", late)).day).toMatchObject({ used: 15, reserved: 0, remaining: 5 });
    expect((await rsvpAllowance("of", after)).day).toMatchObject({ used: 0, remaining: 20 });
    expect((await rsvpAllowance("of", after)).month.used).toBe(15);
    await ledgerMatchesInvitations("of");
  });
});

describe("M13B P4 — failures, uncertainty and stale claims", () => {
  it("FAILED (definite 4xx) releases the reservation and revokes the unsent link; an explicit retry re-reserves with a new idempotency key", async () => {
    const r = await send(OWNER(), "m", "key-fail-000001");
    if (!r.ok) throw new Error();
    setRsvpTransportForTests(failing(() => new EmailDeliveryError("http", 422)));
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 0, failed: 3 });
    const failed = await invitations({ sendId: r.sendId, status: "FAILED" });
    expect(failed).toHaveLength(3);
    expect(failed.every((i) => i.lastError === "HTTP_422" && i.failedAt && i.attempts === 1)).toBe(true);
    expect((await rsvpAllowance("o", NOW)).day).toMatchObject({ used: 0, reserved: 0, remaining: 50 });
    expect(await prisma.personalAttendanceLink.count({ where: { channel: "EMAIL", revokedAt: null } })).toBe(0);

    setRsvpTransportForTests(null);
    expect(await retryFailedInvitations(ctx("u-member", "o", "g", "MEMBER"), r.sendId).catch((e: Error) => e.name)).toBe("TenantContextError");
    expect(await retryFailedInvitations(ctx("u-other", "o2", "g2"), r.sendId, NOW)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await retryFailedInvitations(OWNER(), r.sendId, NOW)).toEqual({ ok: true, requeued: 3, left: 0 });
    expect((await rsvpAllowance("o", NOW)).day.reserved).toBe(3);
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 3 });
    const sent = await invitations({ sendId: r.sendId, status: "SENT" });
    expect(sent.every((i) => i.attempts === 2 && i.idempotencyKey === `rsvp:${i.id}:2`)).toBe(true);
    expect(await prisma.personalAttendanceLink.count({ where: { channel: "EMAIL", revokedAt: null } })).toBe(3);
  });

  it("retry respects the attempt limit, eligibility and the remaining allowance", async () => {
    const r = await send(FREE(), "mf", "key-retry-lim01");
    if (!r.ok) throw new Error();
    setRsvpTransportForTests(failing(() => new EmailDeliveryError("http", 400)));
    await processRsvpQueue({ now: NOW });
    setRsvpTransportForTests(null);
    const failed = await invitations({ sendId: r.sendId, status: "FAILED" });
    await prisma.rsvpInvitation.update({ where: { id: failed[0].id }, data: { attempts: 3 } }); // exhausted
    await prisma.attendanceResponse.create({ data: { matchId: "mf", groupId: "gf", playerId: failed[1].playerId!, participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: NOW } }); // answered meanwhile
    await fillLedger(10, "SENT", NOW); // only 10 left today
    expect(await retryFailedInvitations(FREE(), r.sendId, NOW)).toEqual({ ok: true, requeued: 10, left: 9 });
    expect((await rsvpAllowance("of", NOW)).day).toMatchObject({ used: 20, remaining: 0 });
  });

  it("UNCERTAIN (timeout / 5xx / 409) stays counted, keeps its link, and is never retried automatically", async () => {
    const r = await send(OWNER(), "m", "key-uncertain01");
    if (!r.ok) throw new Error();
    const errors = [new EmailDeliveryError("timeout"), new EmailDeliveryError("http", 503), new EmailDeliveryError("http", 409)];
    setRsvpTransportForTests({ name: "flaky", send: async () => Promise.reject(errors.shift()) });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ uncertain: 3, failed: 0 });
    expect((await invitations({ sendId: r.sendId, status: "UNCERTAIN" })).map((i) => i.lastError).sort()).toEqual(["HTTP_409", "HTTP_503", "TIMEOUT"]);
    expect((await rsvpAllowance("o", NOW)).day).toMatchObject({ used: 3, reserved: 0, remaining: 47 });
    expect(await prisma.personalAttendanceLink.count({ where: { channel: "EMAIL", revokedAt: null } })).toBe(3);
    setRsvpTransportForTests(null);
    expect(await retryFailedInvitations(OWNER(), r.sendId, NOW)).toEqual({ ok: true, requeued: 0, left: 0 });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 0, remaining: 0 });
    expect(testOutbox.sent).toHaveLength(0);
    expect(await send(OWNER(), "m", "key-uncertain02")).toEqual({ ok: false, code: "ALREADY_SENT" });
  });

  it("a configuration error before hand-off is FAILED (nothing reached the provider)", async () => {
    const r = await send(OWNER(), "m", "key-config-0001");
    if (!r.ok) throw new Error();
    vi.stubEnv("EMAIL_FROM", "");
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ failed: 3 });
    expect((await invitations({ sendId: r.sendId, status: "FAILED" })).every((i) => i.lastError === "CONFIG")).toBe(true);
  });

  it("stale SENDING (crashed worker) becomes UNCERTAIN, not resent; a fresh claim is left alone", async () => {
    const r = await send(OWNER(), "m", "key-stale-00001");
    if (!r.ok) throw new Error();
    const [a, b] = await invitations({ sendId: r.sendId, status: "QUEUED" });
    await prisma.rsvpInvitation.update({ where: { id: a.id }, data: { status: "SENDING", attempts: 1, claimedAt: new Date(NOW.getTime() - RSVP_STALE_SENDING_MS - 1000) } });
    await prisma.rsvpInvitation.update({ where: { id: b.id }, data: { status: "SENDING", attempts: 1, claimedAt: new Date(NOW.getTime() - RSVP_STALE_SENDING_MS + 60_000) } });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ recovered: 1, sent: 1 });
    expect(await prisma.rsvpInvitation.findUnique({ where: { id: a.id } })).toMatchObject({ status: "UNCERTAIN", lastError: "STALE_CLAIM", attempts: 1 });
    expect(await prisma.rsvpInvitation.findUnique({ where: { id: b.id } })).toMatchObject({ status: "SENDING", attempts: 1 });
    expect(testOutbox.sent).toHaveLength(1);
    expect((await rsvpAllowance("o", NOW)).day.used).toBe(3);
    // Raw-SQL timestamps are UTC regardless of the session TimeZone (the local test database runs America/New_York).
    expect((await invitations({ sendId: r.sendId, status: "SENT" }))[0].claimedAt).toEqual(NOW);
  });
});

describe("M13B P4 — eligibility is re-checked at send time", () => {
  it("Telegram, canceled, completed, closed and past-deadline matches are refused; nothing is created", async () => {
    const chat = await prisma.telegramChat.create({ data: { chatId: -100n, title: "Chat", groupId: "g" } });
    await prisma.match.update({ where: { id: "m" }, data: { telegramChatId: chat.id } });
    expect(await send(OWNER(), "m", "key-tg-0000001")).toEqual({ ok: false, code: "TELEGRAM_MATCH" });
    await prisma.match.update({ where: { id: "m" }, data: { telegramChatId: null } });
    await prisma.telegramPoll.create({ data: { pollId: "poll", chatId: -100n, question: "q", optionsJson: "[]", groupId: "g", matchId: "m", kind: "ATTENDANCE" } });
    expect(await send(OWNER(), "m", "key-tg-0000002")).toEqual({ ok: false, code: "TELEGRAM_MATCH" });
    for (const [data, code] of [
      [{ status: "CANCELED" }, "MATCH_CANCELED"],
      [{ status: "COMPLETED" }, "MATCH_COMPLETED"],
      [{ status: "SCHEDULED", attendanceClosedAt: NOW }, "ATTENDANCE_CLOSED"],
      [{ attendanceClosedAt: null, attendanceDeadlineAt: new Date(NOW.getTime() - 1000) }, "DEADLINE_PASSED"],
    ] as const) {
      await prisma.match.update({ where: { id: "mb" }, data });
      expect(await send(OWNER(), "mb", `key-state-${code}`), code).toEqual({ ok: false, code });
    }
    expect(await prisma.rsvpSend.count()).toBe(0);
    expect(await prisma.rsvpInvitation.count()).toBe(0);
  });

  it("a match canceled or turned Telegram after queuing: rows are SKIPPED, nothing sent, reservation released", async () => {
    const r = await send(OWNER(), "m", "key-later-00001");
    if (!r.ok) throw new Error();
    await prisma.match.update({ where: { id: "m" }, data: { status: "CANCELED" } });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ skipped: 3, sent: 0 });
    expect((await invitations({ sendId: r.sendId, playerId: { in: ["p1", "p2", "p3"] } })).map((i) => i.skipReason)).toEqual(Array(3).fill("MATCH_CANCELED"));
    expect((await rsvpAllowance("o", NOW)).day.used).toBe(0);
    expect(await prisma.personalAttendanceLink.count()).toBe(0);

    const r2 = await send(OWNER(), "mb", "key-later-00002");
    if (!r2.ok) throw new Error();
    await prisma.telegramPoll.create({ data: { pollId: "poll2", chatId: -100n, question: "q", optionsJson: "[]", groupId: "g", matchId: "mb", kind: "ATTENDANCE" } });
    await processRsvpQueue({ now: NOW });
    expect(new Set((await invitations({ sendId: r2.sendId, status: "SKIPPED", reservedAt: { not: null } })).map((i) => i.skipReason))).toEqual(new Set(["TELEGRAM_MATCH"]));
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("an answer, an organizer override or a suppression after queuing skips that player only", async () => {
    const r = await send(OWNER(), "m", "key-recheck-001");
    if (!r.ok) throw new Error();
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p1", overrideStatus: "PLAYING", overrideAt: NOW, overrideByUserId: "u-owner" } });
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "NOT_PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: NOW } });
    await recordGlobalSuppression("LINKED@example.test", "HARD_BOUNCE", "itest");
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 0, skipped: 3 });
    expect(await byPlayer(r.sendId)).toMatchObject({ p1: { skipReason: "ORGANIZER_OVERRIDE" }, p2: { skipReason: "ALREADY_ANSWERED" }, p3: { skipReason: "SUPPRESSED" } });
    expect(await prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId: "m", playerId: "p2" } } })).toMatchObject({ participantStatus: "NOT_PLAYING" }); // untouched
  });

  it("a player deleted after queuing is skipped", async () => {
    const r = await send(OWNER(), "m", "key-deleted-001");
    if (!r.ok) throw new Error();
    await prisma.player.delete({ where: { id: "p2" } });
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 2, skipped: 1 });
    expect(await prisma.rsvpInvitation.count({ where: { sendId: r.sendId, playerId: null, skipReason: "PLAYER_REMOVED" } })).toBe(1);
  });
});

describe("M13B P4 — tenant isolation and roles", () => {
  it("other organizations and groups can't send for a match; MEMBERs can't send", async () => {
    expect(await send(ctx("u-other", "o2", "g2"), "m", "key-iso-0000001")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await send(ctx("u-owner", "o", "gx"), "m", "key-iso-0000002")).toEqual({ ok: false, code: "NOT_FOUND" });
    await expect(send(ctx("u-member", "o", "g", "MEMBER"), "m", "key-iso-0000003")).rejects.toMatchObject({ name: "TenantContextError" });
    expect(await prisma.rsvpSend.count()).toBe(0);
    // A requestKey owned by another organization is never revealed.
    expect(await send(ctx("u-other", "o2", "g2"), "m2", "key-iso-0000004")).toMatchObject({ ok: true });
    expect(await send(OWNER(), "m", "key-iso-0000004")).toEqual({ ok: false, code: "REQUEST_KEY_CONFLICT" });
    const rows = await invitations({ organizationId: "o2" });
    expect(rows.map((i) => i.playerId)).toEqual(["q1"]);
  });
});

describe("M13B P4 — personal link lifecycle", () => {
  it("manual links survive emailing; manual regenerate keeps emailed links; a resend replaces only the older emailed link after acceptance", async () => {
    const manual = await issuePersonalLinks({ organizationId: "o", groupId: "g", matchId: "m", userId: "u-owner", playerIds: ["p2"] });
    if (!manual.ok) throw new Error();
    const manualToken = manual.links[0].path.split("#")[1];

    const r1 = await send(OWNER(), "m", "key-links-00001");
    if (!r1.ok) throw new Error();
    await processRsvpQueue({ now: NOW });
    const email1 = answerToken(mailTo("ben@example.com")[0].text);
    expect((await personalView(manualToken))?.state).toBe("open"); // the manual link still works
    expect((await personalView(email1))?.state).toBe("open");

    const regen = await issuePersonalLinks({ organizationId: "o", groupId: "g", matchId: "m", userId: "u-owner", playerIds: ["p2"] });
    if (!regen.ok) throw new Error();
    const manual2 = regen.links[0].path.split("#")[1];
    expect((await personalView(manualToken))?.state).toBe("revoked"); // regenerate replaces the MANUAL link only
    expect((await personalView(email1))?.state).toBe("open");

    // A failed resend leaves the earlier emailed link working.
    setRsvpTransportForTests(failing(() => new EmailDeliveryError("http", 422)));
    const r2 = await send(OWNER(), "m", "key-links-00002", "RESEND");
    if (!r2.ok) throw new Error();
    await processRsvpQueue({ now: NOW });
    expect((await personalView(email1))?.state).toBe("open");

    // An accepted resend revokes the older emailed link; the newest manual link is untouched.
    setRsvpTransportForTests(null);
    expect(await send(OWNER(), "m", "key-links-00003", "RESEND")).toMatchObject({ ok: true, round: 3 });
    await processRsvpQueue({ now: NOW });
    const email2 = answerToken(mailTo("ben@example.com")[1].text);
    expect((await personalView(email1))?.state).toBe("revoked");
    expect((await personalView(email2))?.state).toBe("open");
    expect((await personalView(manual2))?.state).toBe("open");
    expect(await prisma.personalAttendanceLink.count({ where: { playerId: "p2", revokedAt: null } })).toBe(2); // one MANUAL + one EMAIL
  });

  it("existing manual links (created before P4) default to the MANUAL channel", async () => {
    await issuePersonalLinks({ organizationId: "o", groupId: "g", matchId: "m", userId: "u-owner" });
    expect(new Set((await prisma.personalAttendanceLink.findMany({ select: { channel: true } })).map((l) => l.channel))).toEqual(new Set(["MANUAL"]));
    const [{ dflt }] = await prisma.$queryRawUnsafe<Array<{ dflt: string }>>(`SELECT column_default AS dflt FROM information_schema.columns WHERE table_name = 'PersonalAttendanceLink' AND column_name = 'channel'`);
    expect(dflt).toContain("MANUAL");
  });
});

describe("M13B P4 — no real delivery", () => {
  it("outside NODE_ENV=test nothing can be queued or delivered (server-side), whatever the email configuration", async () => {
    const r = await send(OWNER(), "m", "key-env-0000001");
    if (!r.ok) throw new Error();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_itest_not_a_key");
    expect(await send(OWNER(), "mb", "key-env-0000002")).toEqual({ ok: false, code: "DELIVERY_DISABLED" });
    await expect(processRsvpQueue({ now: NOW })).rejects.toBeInstanceOf(RsvpDeliveryDisabledError);
    expect(await retryFailedInvitations(OWNER(), r.sendId, NOW)).toEqual({ ok: false, code: "DELIVERY_DISABLED" });
    expect(() => setRsvpTransportForTests(testOutbox)).toThrow(RsvpDeliveryDisabledError);
    expect(await prisma.rsvpInvitation.count({ where: { sendId: r.sendId, status: "QUEUED" } })).toBe(3); // nothing claimed
    expect(testOutbox.sent).toHaveLength(0);
    expect(await prisma.rsvpSend.count()).toBe(1);
  });

  it("Resend serialization (fake fetch injected, no network): idempotency key and unsubscribe headers reach the payload", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ id: `re_${calls.length}` }) } as Response;
    }) as unknown as typeof fetch;
    setRsvpTransportForTests(createResendTransport({ apiKey: "re_itest_fake", fetchImpl: fakeFetch }));
    const r = await send(OWNER(), "m", "key-resend-ser1");
    if (!r.ok) throw new Error();
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await processRsvpQueue({ now: NOW })).toMatchObject({ sent: 3 });
    spy.mockRestore();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe(RESEND_ENDPOINT);
      expect(c.headers["Idempotency-Key"]).toMatch(/^rsvp:[a-z0-9]+:1$/);
      expect(c.body.headers).toEqual({ "List-Unsubscribe": expect.stringMatching(/^<http:\/\/itest\.local\/api\/email\/unsubscribe\/one-click\?t=/), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(Object.keys(c.body).sort()).toEqual(["from", "headers", "html", "subject", "text", "to"]);
    }
    expect((await invitations({ sendId: r.sendId, status: "SENT" })).map((i) => i.providerMessageId).sort()).toEqual(["re_1", "re_2", "re_3"]);
  });
});
