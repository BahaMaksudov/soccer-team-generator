/**
 * M13B P5 — organizer Send API, delivery dashboard, recipient RSVP page and queue
 * continuation. REAL DATABASE (guarded local test DB only). Delivery goes to the
 * in-memory test outbox only; network is forbidden (global fetch throws and is counted).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as sendRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-send/route";
import * as previewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-preview/route";
import * as attendView from "@/app/api/attend/route";
import * as attendAnswer from "@/app/api/attend/answer/route";
import * as cronRoute from "@/app/api/cron/automation/route";
import { createRsvpSend, processRsvpQueue, setRsvpTransportForTests } from "@/lib/rsvpSend";
import { rsvpAllowance } from "@/lib/rsvpPreview";
import type { TenantContext } from "@/lib/tenantContext";
import { EmailDeliveryError, testOutbox } from "@/lib/email/transport";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
/** M13B P6 — contacts seeded directly carry an organizer confirmation (unconfirmed contacts are never emailed). */
const AUTH_AT = new Date("2026-01-01T00:00:00Z");
const ORIGIN = "http://itest.local";
const CRON = "a-long-enough-test-secret";
let network = 0;
const originalFetch = global.fetch;

const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const params = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const read = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }); // eslint-disable-line
const jsonReq = (body: unknown, init: { origin?: string | null; type?: string } = {}) =>
  new Request(`${ORIGIN}/api/x`, {
    method: "POST",
    headers: { "content-type": init.type ?? "application/json", ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }) },
    body: JSON.stringify(body),
  });
const post = async (body: unknown, matchId = "m", org = "o", group = "g", init = {}) => read(await sendRoute.POST(jsonReq(body, init), params(matchId, org, group)));
const status = async (matchId = "m", org = "o", group = "g") => read(await sendRoute.GET(new Request(`${ORIGIN}/api/x`), params(matchId, org, group)));
const preview = async (matchId = "m", org = "o", group = "g") => read(await previewRoute.GET(new Request(`${ORIGIN}/api/x`), params(matchId, org, group)));
const send = (expectedCount: number, requestKey = "key-p5-00000001", extra: Record<string, unknown> = {}) => ({ action: "send", kind: "INITIAL", requestKey, expectedCount, attested: true, ...extra });
const view = async (token: string) => read(await attendView.POST(jsonReq({ token }, { origin: null })));
const answer = async (token: string, s: string, origin: string | null = ORIGIN) => read(await attendAnswer.POST(jsonReq({ token, status: s }, { origin })));
const cron = async (auth = `Bearer ${CRON}`) => read(await cronRoute.POST(new Request(`${ORIGIN}/api/cron/automation`, { method: "POST", headers: { authorization: auth } })));
const mailTo = (to: string) => testOutbox.sent.filter((m) => m.to === to);
const tokenOf = (text: string) => /Answer: \S+#(\S+)/.exec(text)![1];
const ctx = (userId: string, organizationId: string, groupId: string): TenantContext => {
  const group = { id: groupId, name: groupId, slug: groupId, sportKey: "soccer", timezone: TZ };
  return { user: { id: userId, email: `${userId}@example.test`, name: userId }, organization: { id: organizationId, name: organizationId, slug: organizationId }, membership: { id: `m-${userId}`, role: "OWNER" }, groups: [group], activeGroup: group };
};

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "RsvpEmailUsage","RsvpInvitation","RsvpSend","EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PersonalAttendanceLink","AttendanceResponse","TelegramPoll","TelegramChat","MatchAutomation","MatchSchedule","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
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
      P("p1", "g", "Ava", { contactEmail: "guardian.of.ava@example.com", contactEmailType: "GUARDIAN", contactAuthorizedAt: AUTH_AT }),
      P("p2", "g", "Ben", { contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT }),
      P("p3", "g", "Cal", { userId: "u-linked" }),
      P("p4", "g", "Dee"),
      P("p5", "g", "Eve", { contactEmail: "eve@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT }), // opted out
      P("q1", "g2", "Quinn", { contactEmail: "quinn@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT }),
      ...Array.from({ length: 3 }, (_, i) => P(`f${i}`, "gf", `F${i}`, { contactEmail: `f${i}@example.com`, contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT })),
    ],
  });
  await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "eve@example.com", source: "LINK" } });
  await prisma.match.createMany({
    data: [
      { id: "m", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00", locationName: "Field 2", attendanceDeadlineAt: new Date("2099-06-03T18:00:00Z") },
      { id: "mb", groupId: "g", date: new Date("2099-06-10") },
      { id: "m2", groupId: "g2", date: new Date("2099-06-03") },
      { id: "mf", groupId: "gf", date: new Date("2099-06-03") },
    ],
  });
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
  vi.stubEnv("APP_BASE_URL", ORIGIN);
  vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@tbp.itest>");
  vi.stubEnv("CRON_SECRET", CRON);
  network = 0;
  testOutbox.clear();
  setRsvpTransportForTests(null);
  await seed();
  signIn("owner");
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

describe("M13B P5 — Send API: authorization, CSRF and the delivery gate", () => {
  it("signed out → 401; MEMBER, another organization, another group's URL, unknown match → generic 404; nothing created", async () => {
    signIn(null);
    expect((await post(send(3))).status).toBe(401);
    expect((await status()).status).toBe(401);
    for (const [who, matchId, org, group] of [
      ["member", "m", "o", "g"],
      ["other", "m", "o", "g"],
      ["other", "m", "o2", "g2"],
      ["owner", "nope", "o", "g"],
      ["owner", "m2", "o", "g"],
    ] as const) {
      signIn(who);
      const r = await post(send(3, `key-auth-${who}-${matchId}`), matchId, org, group);
      expect(r.status, `${who} ${matchId}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/example\.com|Ava|Ben/);
      if (who !== "owner") expect((await status(matchId, org, group)).status).toBe(404);
    }
    expect(await prisma.rsvpSend.count()).toBe(0);
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("CSRF: JSON only (415) and same-origin only (403)", async () => {
    expect((await post(send(3), "m", "o", "g", { type: "text/plain" })).status).toBe(415);
    expect((await post(send(3), "m", "o", "g", { origin: null })).status).toBe(403);
    expect((await post(send(3), "m", "o", "g", { origin: "https://evil.example" })).status).toBe(403);
    expect(await prisma.rsvpSend.count()).toBe(0);
  });

  it("Production / Preview / plain dev: POST is refused server-side (403) before anything is read or written; GET stays read-only", async () => {
    for (const env of [{ NODE_ENV: "production", VERCEL_ENV: "production" }, { NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL: "1" }, { NODE_ENV: "development" }]) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.stubEnv("EMAIL_TRANSPORT", "resend");
      vi.stubEnv("RESEND_API_KEY", "re_itest_not_a_key");
      const r = await post(send(3, "key-gate-0000001"));
      expect(r, JSON.stringify(env)).toMatchObject({ status: 403, body: { code: "DELIVERY_DISABLED" } });
      expect((await post({ action: "retry", sendId: "x" })).body.code).toBe("DELIVERY_DISABLED");
      expect((await preview()).body.sending).toEqual({ available: false });
      expect(await status()).toMatchObject({ status: 200, body: { mode: "disabled", sends: [] } });
      vi.unstubAllEnvs();
      vi.stubEnv("APP_BASE_URL", ORIGIN);
      vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@tbp.itest>");
    }
    expect(await prisma.rsvpSend.count()).toBe(0);
    expect(await prisma.rsvpInvitation.count()).toBe(0);
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("the request can't carry recipients, addresses or content; attestation and count are required", async () => {
    for (const body of [
      { ...send(3), to: "x@evil.test" },
      { ...send(3), html: "<b>hi</b>" },
      { ...send(3), playerIds: ["p1"] },
      { ...send(3), attested: false },
      { action: "send", kind: "INITIAL", requestKey: "key-missing-0001", attested: true },
      { ...send(3), requestKey: "short" },
      { ...send(3), kind: "BLAST" },
      { action: "nuke" },
    ]) expect((await post(body)).body.code, JSON.stringify(body)).toBe("INVALID_REQUEST");
    expect(await prisma.rsvpSend.count()).toBe(0);
  });
});

describe("M13B P5 — sending", () => {
  it("review → send: queues the reviewed recipients, records the attestation, delivers a first batch to the test outbox", async () => {
    const p = await preview();
    expect(p.body).toMatchObject({ counts: { willSend: 3 }, sending: { available: true } });
    const r = await post(send(3));
    expect(r).toMatchObject({ status: 200, body: { ok: true, round: 1, duplicate: false, counts: { queued: 3 }, run: { sent: 3, remaining: 0 } } });
    expect(testOutbox.sent.map((m) => m.to).sort()).toEqual(["ben@example.com", "guardian.of.ava@example.com", "linked@example.test"]);
    expect(mailTo("eve@example.com")).toHaveLength(0); // opted out
    const s = await prisma.rsvpSend.findFirstOrThrow();
    expect(s).toMatchObject({ kind: "INITIAL", createdByUserId: "u-owner", confirmedCount: 3 });
    expect(s.attestedAt).toBeInstanceOf(Date);
    // Guardian handling: neutral subject, guardian wording in the body.
    const [g] = mailTo("guardian.of.ava@example.com");
    expect(g.subject).toBe("RSVP: Wednesday — Wednesday, June 3 at 9:00 PM");
    expect(g.text).toContain("parent / guardian contact for Ava Test");
    expect(g.text).toMatch(/Yes, playing: http:\/\/itest\.local\/attend\?c=yes#[A-Za-z0-9_-]+/);
    // No address or token in the response.
    expect(JSON.stringify(r.body)).not.toMatch(/@example|attend#/);
  });

  it("idempotent: the same request key (double click, concurrently) is one send and one email each", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post(send(3, "key-double-p5-01"))));
    expect(results.every((x) => x.status === 200)).toBe(true);
    expect(new Set(results.map((x) => x.body.sendId)).size).toBe(1);
    expect(results.filter((x) => x.body.duplicate === false)).toHaveLength(1);
    expect(await prisma.rsvpSend.count()).toBe(1);
    expect(testOutbox.sent).toHaveLength(3);
    // A different key for the same match is not a second initial send.
    expect(await post(send(3, "key-double-p5-02"))).toMatchObject({ status: 409, body: { code: "ALREADY_SENT" } });
  });

  it("changed roster since review → 409 ROSTER_CHANGED with the new count; nothing queued", async () => {
    expect((await preview()).body.counts.willSend).toBe(3);
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: new Date() } });
    expect(await post(send(3))).toMatchObject({ status: 409, body: { code: "ROSTER_CHANGED", willSend: 2, error: expect.stringMatching(/changed since you reviewed/) } });
    expect(await prisma.rsvpSend.count()).toBe(0);
    expect(await post(send(2, "key-roster-00002"))).toMatchObject({ status: 200, body: { counts: { queued: 2 } } });
  });

  it("clear refusals: deadline passed, Telegram-managed, closed, canceled, quota exhausted", async () => {
    await prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: new Date(Date.now() - 1000) } });
    expect(await post(send(3))).toMatchObject({ status: 409, body: { code: "DEADLINE_PASSED", error: expect.stringMatching(/deadline .* has passed/) } });
    const chat = await prisma.telegramChat.create({ data: { chatId: -100n, title: "Chat", groupId: "g" } });
    await prisma.match.update({ where: { id: "mb" }, data: { telegramChatId: chat.id } });
    expect(await post(send(3, "key-tg-p5-00001"), "mb")).toMatchObject({ status: 409, body: { code: "TELEGRAM_MATCH", error: expect.stringMatching(/Telegram poll/) } });
    await prisma.match.update({ where: { id: "mb" }, data: { telegramChatId: null, status: "CANCELED" } });
    expect((await post(send(3, "key-cn-p5-00001"), "mb")).body.code).toBe("MATCH_CANCELED");
    await prisma.match.update({ where: { id: "mb" }, data: { status: "SCHEDULED", attendanceClosedAt: new Date() } });
    expect((await post(send(3, "key-cl-p5-00001"), "mb")).body.code).toBe("ATTENDANCE_CLOSED");
    // Free: today's 20 already consumed (durable ledger) → PLAN_LIMIT with the reset explained.
    const today = new Date().toISOString().slice(0, 10);
    await prisma.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES ('of', ${today}::date, 20)`;
    signIn("free");
    expect(await post(send(3, "key-quota-p5-001"), "mf", "of", "gf")).toMatchObject({ status: 409, body: { code: "PLAN_LIMIT", error: expect.stringMatching(/00:00 UTC/) } });
    expect(await prisma.rsvpSend.count()).toBe(0);
  });

  it("database rate limit: at most 10 new sends per organization per 10 minutes (a repeated key still answers)", async () => {
    await post(send(3, "key-rl-first-0001"));
    for (let i = 0; i < 9; i++) await prisma.rsvpSend.create({ data: { organizationId: "o", groupId: "g", matchId: "mb", kind: i ? "RESEND" : "INITIAL", round: i + 1, requestKey: `key-rl-fill-${i}-000` } });
    expect(await post(send(3, "key-rl-new-00001"), "mb")).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(await post(send(3, "key-rl-first-0001"))).toMatchObject({ status: 200, body: { duplicate: true } });
  });

  it("concurrent sends for different matches never exceed the remaining allowance", async () => {
    await prisma.match.create({ data: { id: "mf2", groupId: "gf", date: new Date("2099-06-04") } });
    const today = new Date().toISOString().slice(0, 10);
    await prisma.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES ('of', ${today}::date, 16)`;
    signIn("free");
    expect((await preview("mf", "of", "gf")).body.counts.willSend).toBe(3);
    const [a, b] = await Promise.all([post(send(3, "key-cq-p5-00001"), "mf", "of", "gf"), post(send(3, "key-cq-p5-00002"), "mf2", "of", "gf")]);
    // Each reviewed 3 sendable, but only 4 remain today: the second to lock sees a changed count.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await rsvpAllowance("of")).day).toMatchObject({ used: 19, remaining: 1 });
  });
});

describe("M13B P5 — delivery dashboard", () => {
  it("delivery status and RSVP status are separate; uncertain is flagged; masked destinations only", async () => {
    let n = 0;
    setRsvpTransportForTests({ name: "mixed", send: async (m) => (++n === 2 ? Promise.reject(new EmailDeliveryError("timeout")) : testOutbox.send(m)) });
    // P8A.1: the timeout ends the inline run; the next worker run finishes the queue.
    expect((await post(send(3))).body.run).toMatchObject({ sent: 1, uncertain: 1, stoppedForProvider: true });
    expect(await processRsvpQueue()).toMatchObject({ sent: 1, remaining: 0 });
    // Answers from the emailed links: Yes and Maybe; the organizer overrides the third to No.
    const [first, second] = testOutbox.sent; // the uncertain one never reached the outbox
    expect((await answer(tokenOf(first.text), "PLAYING")).status).toBe(200);
    expect((await answer(tokenOf(second.text), "MAYBE")).status).toBe(200);
    const uncertainPlayer = (await prisma.rsvpInvitation.findFirstOrThrow({ where: { status: "UNCERTAIN" } })).playerId!;
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: uncertainPlayer, overrideStatus: "NOT_PLAYING", overrideAt: new Date(), overrideByUserId: "u-owner" } });
    expect(testOutbox.sent).toHaveLength(2);

    const s = await status();
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      mode: "test-outbox",
      sends: [{ round: 1, kind: "INITIAL", counts: { queued: 0, processing: 0, accepted: 2, failed: 0, uncertain: 1, skipped: 2 }, retryable: 0 }],
      totals: { delivery: { accepted: 2, uncertain: 1, skipped: 2 }, rsvp: { yes: 1, maybe: 1, no: 1, unanswered: 0 }, inProgress: false, uncertain: 1 },
    });
    const byName = Object.fromEntries((s.body.recipients as Array<{ name: string; delivery: string }>).map((r) => [r.name, r]));
    expect(byName["Eve Test"]).toMatchObject({ delivery: "SKIPPED", skipReason: "SUPPRESSED", rsvp: null });
    expect(Object.values(byName).find((r) => r.delivery === "UNCERTAIN")).toMatchObject({ rsvp: "NOT_PLAYING", rsvpSetByOrganizer: true });
    const text = JSON.stringify(s.body);
    for (const secret of ["guardian.of.ava@", "ben@", "linked@", "eve@", "attend#", "tokenHash", "idempotencyKey"]) expect(text, secret).not.toContain(secret);
    expect(text).toContain("b•••@example.com");
  });

  it("retry (FAILED only) and resend (unanswered) through the API", async () => {
    setRsvpTransportForTests({ name: "reject", send: async () => Promise.reject(new EmailDeliveryError("http", 422)) });
    expect((await post(send(3))).body.run).toMatchObject({ failed: 3 });
    const sendId = (await prisma.rsvpSend.findFirstOrThrow()).id;
    expect((await status()).body.sends[0]).toMatchObject({ retryable: 3, counts: { failed: 3 } });
    setRsvpTransportForTests(null);
    expect(await post({ action: "retry", sendId })).toMatchObject({ status: 200, body: { requeued: 3, run: { sent: 3 } } });
    signIn("other");
    expect((await post({ action: "retry", sendId }, "m2", "o2", "g2")).body.code).toBe("NOT_FOUND"); // another tenant's send
    signIn("owner");
    // Ben answers; a resend goes to the two who haven't.
    await answer(tokenOf(mailTo("ben@example.com")[0].text), "NOT_PLAYING");
    const willSend = (await preview()).body.counts.willSend;
    expect(willSend).toBe(2);
    expect(await post({ ...send(willSend, "key-resend-p5-01"), kind: "RESEND" })).toMatchObject({ status: 200, body: { round: 2, counts: { queued: 2 }, run: { sent: 2 } } });
    expect(mailTo("ben@example.com")).toHaveLength(1);
    expect((await status()).body.totals.rsvp).toEqual({ yes: 0, maybe: 0, no: 1, unanswered: 2 });
  });

  it("a Telegram match keeps its email history visible but refuses new sends", async () => {
    await post(send(3));
    await prisma.telegramPoll.create({ data: { pollId: "poll", chatId: -100n, question: "q", optionsJson: "[]", groupId: "g", matchId: "m", kind: "ATTENDANCE" } });
    expect((await preview()).body.code).toBe("TELEGRAM_MATCH");
    expect((await status()).body.totals.delivery.accepted).toBe(3);
    expect((await post({ ...send(3, "key-tg-resend-01"), kind: "RESEND" })).body.code).toBe("TELEGRAM_MATCH");
  });
});

describe("M13B P5 — recipient RSVP page", () => {
  async function invite() {
    await post(send(3));
    return tokenOf(mailTo("ben@example.com")[0].text);
  }
  const ben = () => prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId: "m", playerId: "p2" } } });

  it("email scanners / previews opening every link never change attendance; answering needs a same-origin POST", async () => {
    const token = await invite();
    const [mail] = mailTo("ben@example.com");
    for (const url of [...mail.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])) expect(url).not.toMatch(/\/api\//); // links open pages, never APIs
    for (let i = 0; i < 5; i++) expect((await view(token)).body.state).toBe("open"); // what the page does on load
    expect(await ben()).toBeNull();
    expect((await answer(token, "PLAYING", null)).status).toBe(403); // a scanner's cross-site / origin-less POST
    expect(await ben()).toBeNull();
  });

  it("Yes / Maybe / No; repeated and racing submissions leave one consistent row", async () => {
    const token = await invite();
    for (const s of ["PLAYING", "MAYBE", "NOT_PLAYING"]) {
      expect(await answer(token, s)).toMatchObject({ status: 200, body: { ok: true, status: s } });
      expect(await ben()).toMatchObject({ participantStatus: s, participantSource: "PERSONAL_LINK" });
    }
    await Promise.all([answer(token, "PLAYING"), answer(token, "PLAYING"), answer(token, "MAYBE")]);
    expect(await prisma.attendanceResponse.count({ where: { matchId: "m", playerId: "p2" } })).toBe(1);
    expect(["PLAYING", "MAYBE"]).toContain((await ben())!.participantStatus);
    expect((await answer(token, "YES")).status).toBe(400);
  });

  it("an organizer override keeps precedence; the answer is still recorded", async () => {
    const token = await invite();
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", overrideStatus: "NOT_PLAYING", overrideAt: new Date(), overrideByUserId: "u-owner" } });
    expect(await answer(token, "PLAYING")).toMatchObject({ status: 200, body: { setByOrganizer: true } });
    expect((await view(token)).body.current).toEqual({ status: "NOT_PLAYING", setByOrganizer: true });
  });

  it("closed, canceled, past-deadline, replaced and revoked links", async () => {
    const token = await invite();
    await prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: new Date(Date.now() - 1000) } });
    expect((await view(token)).body.state).toBe("closed");
    expect(await answer(token, "PLAYING")).toMatchObject({ status: 409, body: { code: "closed" } });
    await prisma.match.update({ where: { id: "m" }, data: { attendanceDeadlineAt: null, attendanceClosedAt: new Date() } });
    expect((await answer(token, "PLAYING")).body.code).toBe("closed");
    await prisma.match.update({ where: { id: "m" }, data: { attendanceClosedAt: null, status: "CANCELED" } });
    expect((await answer(token, "PLAYING")).body.code).toBe("canceled");
    await prisma.match.update({ where: { id: "m" }, data: { status: "SCHEDULED", attendanceDeadlineAt: new Date("2099-06-03T18:00:00Z") } });
    // A newer accepted email replaces the older emailed link.
    expect((await post({ ...send(3, "key-replace-p5-1"), kind: "RESEND" })).status).toBe(200);
    expect((await view(token)).body.state).toBe("replaced");
    expect(await answer(token, "PLAYING")).toMatchObject({ status: 410, body: { code: "replaced", error: expect.stringMatching(/most recent email/) } });
    const newest = tokenOf(mailTo("ben@example.com")[1].text);
    expect((await view(newest)).body.state).toBe("open");
    await prisma.personalAttendanceLink.updateMany({ where: { playerId: "p2", revokedAt: null }, data: { revokedAt: new Date() } }); // organizer revoke
    expect((await view(newest)).body.state).toBe("revoked");
    expect(await ben()).toBeNull();
  });

  it("no registration needed and no other player's data on the page", async () => {
    const token = await invite();
    signIn(null);
    const v = await view(token);
    expect(v.status).toBe(200);
    expect(v.body.playerName).toBe("Ben");
    expect(JSON.stringify(v.body)).not.toMatch(/Ava|Cal|Dee|Eve|@/);
  });
});

describe("M13B P5 — queue continuation (cron)", () => {
  const queue = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const matchId = i ? `mq${i}` : "m";
      if (i) await prisma.match.create({ data: { id: matchId, groupId: "g", date: new Date("2099-07-01") } });
      expect(await createRsvpSend(ctx("u-owner", "o", "g"), matchId, { kind: "INITIAL", requestKey: `key-cron-${i}-00000` })).toMatchObject({ ok: true });
    }
  };

  it("requires the cron secret; continues the queue; never retries UNCERTAIN", async () => {
    await queue();
    expect((await cron("Bearer wrong-secret-value-123")).status).toBe(401);
    expect(await prisma.rsvpInvitation.count({ where: { status: "QUEUED" } })).toBe(3);
    let n = 0;
    setRsvpTransportForTests({ name: "mixed", send: async () => (++n === 1 ? Promise.reject(new EmailDeliveryError("http", 503)) : { providerMessageId: `c${n}` }) });
    const r = await cron();
    // P8A.1: the 503 is UNCERTAIN and ends that run; the next scheduled run continues.
    expect(r).toMatchObject({ status: 200, body: { ok: true, rsvp: { sent: 0, uncertain: 1, remaining: 2, errors: 0, stoppedForProvider: true } } });
    expect((await cron()).body.rsvp).toMatchObject({ sent: 2, uncertain: 0, remaining: 0 });
    expect((await cron()).body.rsvp).toMatchObject({ sent: 0, uncertain: 0, remaining: 0 });
    expect(n).toBe(3);
  });

  it("overlapping scheduler runs never process an invitation twice", async () => {
    await queue(4); // 12 invitations
    const runs = await Promise.all([cron(), cron(), cron()]);
    expect(runs.reduce((t, x) => t + (x.body.rsvp?.sent ?? 0), 0)).toBe(12);
    expect(testOutbox.sent).toHaveLength(12);
    expect(new Set(testOutbox.sent.map((m) => m.idempotencyKey)).size).toBe(12);
  });

  it("in Production / Preview the scheduler claims nothing and sends nothing", async () => {
    await queue();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = await cron();
    expect(r.body.rsvp).toEqual({ disabled: true });
    expect(await prisma.rsvpInvitation.count({ where: { status: "QUEUED" } })).toBe(3);
    expect(testOutbox.sent).toHaveLength(0);
  });
});
