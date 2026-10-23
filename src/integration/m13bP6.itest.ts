/**
 * M13B P6 — delivery management, contact authorization, unsubscribe hardening and the
 * Resend webhook. REAL DATABASE (guarded local test DB only). Delivery goes to the
 * in-memory test outbox only; network is forbidden (global fetch throws and is counted);
 * webhooks are signed locally with a fake test secret.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as contactRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/contact/route";
import * as sendRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-send/route";
import * as previewRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-preview/route";
import * as unsubPreview from "@/app/api/email/unsubscribe/preview/route";
import * as unsubConfirm from "@/app/api/email/unsubscribe/route";
import * as oneClick from "@/app/api/email/unsubscribe/one-click/route";
import * as webhookRoute from "@/app/api/email/webhooks/resend/route";
import { setRsvpTransportForTests } from "@/lib/rsvpSend";
import { issuePersonalLinks, personalView } from "@/lib/personalAttendance";
import { signWebhookForTests } from "@/lib/webhookSignature";
import { EmailDeliveryError, testOutbox } from "@/lib/email/transport";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
const ORIGIN = "http://itest.local";
const WH_SECRET = "whsec_" + Buffer.alloc(32, 9).toString("base64"); // fake, local only
let network = 0;
const originalFetch = global.fetch;

const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
type Body = Record<string, any>; // eslint-disable-line
const read = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Body });
const jsonReq = (method: string, body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/x`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const mp = (matchId: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, matchId }) });
const pp = (id: string, org = "o", group = "g") => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group, id }) });
const putContact = async (id: string, body: unknown, org = "o", group = "g") => read(await contactRoute.PUT(jsonReq("PUT", body), pp(id, org, group)));
const getContact = async (id: string) => read(await contactRoute.GET(new Request(`${ORIGIN}/api/x`), pp(id)));
const preview = async (matchId = "m") => read(await previewRoute.GET(new Request(`${ORIGIN}/api/x`), mp(matchId)));
const status = async (matchId = "m") => read(await sendRoute.GET(new Request(`${ORIGIN}/api/x`), mp(matchId)));
const post = async (body: unknown, matchId = "m", org = "o", group = "g") => read(await sendRoute.POST(jsonReq("POST", body), mp(matchId, org, group)));
const send = (expectedCount: number, requestKey: string, kind = "INITIAL") => ({ action: "send", kind, requestKey, expectedCount, attested: true });
const mailTo = (to: string) => testOutbox.sent.filter((m) => m.to === to);
const contactRow = (id: string) => prisma.player.findUniqueOrThrow({ where: { id }, select: { contactEmail: true, contactEmailType: true, contactAuthorizedAt: true, contactAuthorizedByUserId: true } });

async function webhook(event: unknown, opts: { id?: string; secret?: string; at?: number; body?: string; signature?: string } = {}) {
  const body = opts.body ?? JSON.stringify(event);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(opts.at ?? Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? signWebhookForTests(opts.secret ?? WH_SECRET, id, ts, body);
  return read(await webhookRoute.POST(new Request(`${ORIGIN}/api/email/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signature }, body })));
}
const bounced = (to: string[], type: string | undefined = "Permanent") => ({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", to, subject: "RSVP", ...(type ? { bounce: { type, subType: "General", message: "rejected" } } : {}) } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EmailWebhookEvent","RsvpEmailUsage","RsvpInvitation","RsvpSend","EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PersonalAttendanceLink","AttendanceResponse","TelegramPoll","TelegramChat","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other", "linked"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n === "owner" ? "Olivia Owner" : n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "o", name: "Wednesday Club", slug: "o", plan: "LEGACY" }, { id: "o2", name: "Other Club", slug: "o2", plan: "LEGACY" }] });
  await prisma.group.createMany({
    data: [
      { id: "g", organizationId: "o", name: "Wednesday", slug: "g", sportKey: "soccer", timezone: TZ },
      { id: "g2", organizationId: "o2", name: "Other", slug: "g2", sportKey: "soccer", timezone: TZ },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "o", role: "OWNER" },
      { userId: "u-admin", organizationId: "o", role: "ADMIN" },
      { userId: "u-member", organizationId: "o", role: "MEMBER" },
      { userId: "u-other", organizationId: "o2", role: "OWNER" },
    ],
  });
  const P = (id: string, groupId: string, firstName: string, extra: Record<string, unknown> = {}) => ({ id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3, ...extra });
  await prisma.player.createMany({ data: [P("p1", "g", "Ava"), P("p2", "g", "Ben"), P("p3", "g", "Cal", { userId: "u-linked" }), P("q1", "g2", "Quinn")] });
  await prisma.match.createMany({
    data: [
      { id: "m", groupId: "g", date: new Date("2099-06-03"), startTime: "21:00" },
      { id: "m2", groupId: "g2", date: new Date("2099-06-03") },
    ],
  });
}
/** Confirmed contacts through the API (the way organizers do it). */
async function confirmContacts() {
  expect((await putContact("p1", { email: "Guardian.Of.Ava@Example.com", type: "GUARDIAN", authorized: true })).status).toBe(200);
  expect((await putContact("p2", { email: "ben@example.com", type: "PLAYER", authorized: true })).status).toBe(200);
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
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WH_SECRET);
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

describe("M13B P6 — contact authorization", () => {
  it("a new contact needs the organizer's confirmation; who and when are recorded", async () => {
    const refused = await putContact("p1", { email: "guardian@example.com", type: "GUARDIAN" });
    expect(refused).toMatchObject({ status: 400, body: { issues: { fieldErrors: { authorized: [expect.stringMatching(/parent \/ guardian gave you this address/)] } } } });
    expect(await contactRow("p1")).toMatchObject({ contactEmail: null, contactAuthorizedAt: null });
    expect((await putContact("p1", { email: "guardian@example.com", type: "GUARDIAN", authorized: "yes" })).status).toBe(400); // only literal true
    signIn("admin");
    const ok = await putContact("p1", { email: "guardian@example.com", type: "GUARDIAN", authorized: true });
    expect(ok).toMatchObject({ status: 200, body: { contact: { email: "guardian@example.com", type: "GUARDIAN", authorization: { byName: "admin", at: expect.any(String) } } } });
    expect(await contactRow("p1")).toMatchObject({ contactAuthorizedByUserId: "u-admin" });
  });

  it("the same contact re-saved keeps its confirmation; a different address or type needs a fresh one", async () => {
    await putContact("p1", { email: "guardian@example.com", type: "GUARDIAN", authorized: true });
    const first = (await contactRow("p1")).contactAuthorizedAt!;
    signIn("admin");
    expect((await putContact("p1", { email: "  GUARDIAN@example.com ", type: "GUARDIAN" })).status).toBe(200); // not a material change
    expect(await contactRow("p1")).toMatchObject({ contactAuthorizedAt: first, contactAuthorizedByUserId: "u-owner" });
    expect((await putContact("p1", { email: "other.guardian@example.com", type: "GUARDIAN" })).status).toBe(400);
    expect((await putContact("p1", { email: "guardian@example.com", type: "PLAYER" })).body.issues.fieldErrors.authorized[0]).toMatch(/this player gave you/);
    expect(await contactRow("p1")).toMatchObject({ contactEmail: "guardian@example.com", contactEmailType: "GUARDIAN", contactAuthorizedAt: first }); // unchanged
    expect((await putContact("p1", { email: "other.guardian@example.com", type: "GUARDIAN", authorized: true })).status).toBe(200);
    expect(await contactRow("p1")).toMatchObject({ contactEmail: "other.guardian@example.com", contactAuthorizedByUserId: "u-admin" });
  });

  it("removing a contact clears its confirmation; the database refuses a confirmation without a contact", async () => {
    await putContact("p1", { email: "guardian@example.com", type: "GUARDIAN", authorized: true });
    expect((await putContact("p1", { email: null })).body).toMatchObject({ contact: null });
    expect(await contactRow("p1")).toEqual({ contactEmail: null, contactEmailType: null, contactAuthorizedAt: null, contactAuthorizedByUserId: null });
    await expect(prisma.player.update({ where: { id: "p2" }, data: { contactAuthorizedAt: new Date() } })).rejects.toThrow(/Player_contact_authorization_requires_contact/);
  });

  it("organization and group isolation; MEMBERs can't read or confirm; errors never echo database details", async () => {
    signIn("other");
    expect((await putContact("p1", { email: "x@example.com", type: "PLAYER", authorized: true }, "o2", "g2")).status).toBe(404);
    expect((await putContact("p1", { email: "x@example.com", type: "PLAYER", authorized: true })).status).toBe(404);
    signIn("member");
    expect((await putContact("p1", { email: "x@example.com", type: "PLAYER", authorized: true })).status).toBe(404);
    expect((await getContact("p1")).status).toBe(404);
    expect(await contactRow("p1")).toMatchObject({ contactEmail: null });
  });

  it("an unconfirmed contact is never emailed and never falls back to the linked account", async () => {
    await prisma.player.update({ where: { id: "p3" }, data: { contactEmail: "cal.parent@example.com", contactEmailType: "GUARDIAN" } }); // e.g. entered before P6
    await confirmContacts();
    const p = await preview();
    const byId = Object.fromEntries((p.body.recipients as Body[]).map((r) => [r.playerId, r]));
    expect(byId.p3).toMatchObject({ status: "CONTACT_UNCONFIRMED", source: "GUARDIAN", maskedEmail: null });
    expect(p.body.counts.willSend).toBe(2);
    expect((await post(send(2, "key-unconf-00001"))).status).toBe(200);
    expect(testOutbox.sent.map((m) => m.to).sort()).toEqual(["ben@example.com", "guardian.of.ava@example.com"]);
    expect(mailTo("linked@example.test")).toHaveLength(0);
  });

  it("a contact changed or removed after queuing is not emailed at its old address", async () => {
    await confirmContacts();
    setRsvpTransportForTests({ name: "hold", send: async () => Promise.reject(new EmailDeliveryError("http", 400)) });
    // Queue without delivering: the inline batch fails definitively, then a retry is queued and the contact changes.
    await post(send(3, "key-change-00001"));
    setRsvpTransportForTests(null);
    const sendId = (await prisma.rsvpSend.findFirstOrThrow()).id;
    await putContact("p1", { email: "new.guardian@example.com", type: "GUARDIAN", authorized: true });
    await putContact("p2", { email: null });
    expect(await post({ action: "retry", sendId })).toMatchObject({ status: 200 });
    expect(mailTo("guardian.of.ava@example.com")).toHaveLength(0);
    expect(mailTo("ben@example.com")).toHaveLength(0);
    expect(mailTo("linked@example.test")).toHaveLength(1);
  });

  it("send-time re-check: a contact changed between queuing and delivery is skipped (CONTACT_CHANGED)", async () => {
    await confirmContacts();
    const { createRsvpSend, processRsvpQueue } = await import("@/lib/rsvpSend");
    const ctx = { user: { id: "u-owner", email: "owner@example.test", name: "o" }, organization: { id: "o", name: "o", slug: "o" }, membership: { id: "x", role: "OWNER" as const }, groups: [], activeGroup: { id: "g", name: "g", slug: "g", sportKey: "soccer", timezone: TZ } };
    expect(await createRsvpSend(ctx, "m", { kind: "INITIAL", requestKey: "key-recheck-0001" })).toMatchObject({ ok: true });
    await putContact("p1", { email: "new.guardian@example.com", type: "GUARDIAN", authorized: true });
    await prisma.player.update({ where: { id: "p2" }, data: { contactAuthorizedAt: null, contactAuthorizedByUserId: null } });
    expect(await processRsvpQueue()).toMatchObject({ sent: 1, skipped: 2 });
    expect((await prisma.rsvpInvitation.findMany({ where: { skipReason: "CONTACT_CHANGED" } })).map((i) => i.playerId).sort()).toEqual(["p1", "p2"]);
    expect(testOutbox.sent.map((m) => m.to)).toEqual(["linked@example.test"]);
  });
});

describe("M13B P6 — retry and resend", () => {
  it("retry: only definitively failed rows; a double click retries once; uncertain rows are never retried", async () => {
    await confirmContacts();
    let n = 0;
    setRsvpTransportForTests({ name: "mixed", send: async () => Promise.reject(++n === 1 ? new EmailDeliveryError("timeout") : new EmailDeliveryError("http", 422)) });
    expect((await post(send(3, "key-retry-p6-001"))).body.run).toMatchObject({ uncertain: 1, failed: 2 });
    setRsvpTransportForTests(null);
    const sendId = (await prisma.rsvpSend.findFirstOrThrow()).id;
    const [a, b] = await Promise.all([post({ action: "retry", sendId }), post({ action: "retry", sendId })]);
    expect([a.body.requeued, b.body.requeued].sort()).toEqual([0, 2]);
    expect(testOutbox.sent).toHaveLength(2);
    expect(await prisma.rsvpInvitation.count({ where: { status: "UNCERTAIN" } })).toBe(1);
    expect((await post({ action: "retry", sendId })).body.requeued).toBe(0);
  });

  it("resend: unanswered, eligible players only — answered, overridden, unsubscribed and in-flight are excluded; a double click is one send", async () => {
    await confirmContacts();
    await post(send(3, "key-resend-p6-01"));
    // Ben answers, the organizer overrides Cal, Ava's guardian unsubscribes.
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "MAYBE", participantSource: "PERSONAL_LINK", participantRespondedAt: new Date() } });
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p3", overrideStatus: "PLAYING", overrideAt: new Date(), overrideByUserId: "u-owner" } });
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "guardian.of.ava@example.com", source: "LINK" } });
    const p = await preview();
    expect(p.body.counts.willSend).toBe(0);
    expect(await post(send(1, "key-resend-p6-02", "RESEND"))).toMatchObject({ status: 409, body: { code: "NOTHING_TO_RESEND" } });

    await prisma.organizationEmailOptOut.deleteMany();
    await prisma.attendanceResponse.deleteMany({ where: { playerId: "p3" } });
    expect((await preview()).body.counts.willSend).toBe(2);
    const manual = await issuePersonalLinks({ organizationId: "o", groupId: "g", matchId: "m", userId: "u-owner", playerIds: ["p1"] });
    if (!manual.ok) throw new Error("manual link");
    const [x, y] = await Promise.all([post(send(2, "key-resend-p6-03", "RESEND")), post(send(2, "key-resend-p6-03", "RESEND"))]);
    expect(x.body.sendId).toBe(y.body.sendId);
    expect(await prisma.rsvpSend.count()).toBe(2);
    expect(testOutbox.sent).toHaveLength(5); // 3 initial + 2 resent
    expect(mailTo("ben@example.com")).toHaveLength(1);
    // A manual link issued before the resend still works after it.
    expect((await personalView(manual.links[0].path.split("#")[1]))?.state).toBe("open");
  });
});

describe("M13B P6 — delivery dashboard", () => {
  it("per-recipient contact type, masked address, timestamps, explanations data, and later suppression", async () => {
    await confirmContacts();
    await post(send(3, "key-dash-p6-0001"));
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "ONE_CLICK" } });
    const s = await status();
    const byName = Object.fromEntries((s.body.recipients as Body[]).map((r) => [r.name, r]));
    expect(byName["Ava Test"]).toMatchObject({ recipientType: "GUARDIAN", maskedEmail: "g•••@example.com", delivery: "SENT", attempts: 1, suppressedNow: false, at: { queued: expect.any(String), accepted: expect.any(String), failed: null } });
    expect(byName["Ben Test"]).toMatchObject({ recipientType: "PLAYER", delivery: "SENT", suppressedNow: true });
    expect(byName["Cal Test"]).toMatchObject({ recipientType: "ACCOUNT", maskedEmail: "l•••@example.test" });
    const text = JSON.stringify(s.body);
    for (const secret of ["guardian.of.ava@", "ben@", "linked@example.test", "tokenHash", "attend#"]) expect(text, secret).not.toContain(secret);
  });
});

describe("M13B P6 — unsubscribe hardening", () => {
  it("the one-click URL's token (query string, may be logged) only works for one-click; it discloses nothing", async () => {
    await confirmContacts();
    await post(send(3, "key-unsub-p6-001"));
    const [mail] = mailTo("ben@example.com");
    const oneClickUrl = /^<(.+)>$/.exec(mail.headers!["List-Unsubscribe"])![1];
    const oneClickToken = new URL(oneClickUrl).searchParams.get("t")!;
    const pageToken = /unsubscribe#([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    expect(oneClickToken).not.toBe(pageToken);
    // The logged token can't preview (org name / masked address) or confirm on the page.
    expect(await read(await unsubPreview.POST(jsonReq("POST", { token: oneClickToken })))).toMatchObject({ status: 404, body: { state: "invalid" } });
    expect((await read(await unsubConfirm.POST(jsonReq("POST", { token: oneClickToken })))).status).toBe(404);
    expect(await prisma.organizationEmailOptOut.count()).toBe(0);
    // The page token previews; the one-click endpoint opts out (POST only), idempotently.
    expect((await read(await unsubPreview.POST(jsonReq("POST", { token: pageToken })))).body).toMatchObject({ state: "valid", organizationName: "Wednesday Club", maskedEmail: "b•••@example.com" });
    const form = () => new Request(oneClickUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect((await read(await oneClick.POST(form()))).status).toBe(200);
    expect((await read(await oneClick.POST(form()))).status).toBe(200); // replay
    expect(await prisma.organizationEmailOptOut.findMany({ select: { organizationId: true, email: true, source: true } })).toEqual([{ organizationId: "o", email: "ben@example.com", source: "ONE_CLICK" }]);
    expect("GET" in oneClick).toBe(false);
    expect(await prisma.emailUnsubscribeToken.count({ where: { oneClickOnly: true } })).toBe(3);
    // Cross-organization: another organization still reaches the same address.
    signIn("other");
    await putContact("q1", { email: "ben@example.com", type: "PLAYER", authorized: true }, "o2", "g2");
    expect(await post(send(1, "key-unsub-p6-002"), "m2", "o2", "g2")).toMatchObject({ status: 200, body: { counts: { queued: 1 } } });
  });
});

describe("M13B P6 — Resend webhook", () => {
  it("fails closed without a secret; rejects missing, invalid, tampered and stale signatures", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await webhook(bounced(["x@example.com"]))).status).toBe(503);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", WH_SECRET);
    expect((await webhook(bounced(["x@example.com"]), { secret: "whsec_" + Buffer.alloc(32, 1).toString("base64") })).status).toBe(401);
    expect((await webhook(bounced(["x@example.com"]), { signature: "v1,AAAA" })).status).toBe(401);
    const body = JSON.stringify(bounced(["x@example.com"]));
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhookForTests(WH_SECRET, "msg_t", String(ts), body);
    expect((await webhook(null, { id: "msg_t", at: ts, body: body.replace("x@", "y@"), signature: sig })).status).toBe(401);
    expect((await webhook(bounced(["x@example.com"]), { at: ts - 6 * 60 })).status).toBe(401);
    expect(await prisma.globalEmailSuppression.count()).toBe(0);
    expect(await prisma.emailWebhookEvent.count()).toBe(0);
  });

  it("hard bounce and complaint → global suppression (normalized); replays and concurrent duplicates change nothing", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    const r = await webhook(bounced(["  Bounce.Me@Example.COM "]), { id: "msg_bounce_1" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, status: "processed", outcome: "SUPPRESSED" } });
    expect(JSON.stringify(r.body)).not.toMatch(/example/i);
    const replays = await Promise.all([webhook(bounced(["bounce.me@example.com"]), { id: "msg_bounce_1" }), webhook(bounced(["bounce.me@example.com"]), { id: "msg_bounce_1" })]);
    expect(replays.map((x) => x.body.status)).toEqual(["duplicate", "duplicate"]);
    expect(await webhook({ type: "email.complained", data: { to: ["bounce.me@example.com", "angry@example.com"] } }, { id: "msg_complaint_1" })).toMatchObject({ status: 200, body: { outcome: "SUPPRESSED" } });
    expect(await prisma.globalEmailSuppression.findMany({ orderBy: { email: "asc" }, select: { email: true, reason: true, source: true } })).toEqual([
      { email: "angry@example.com", reason: "SPAM_COMPLAINT", source: "resend-webhook" },
      { email: "bounce.me@example.com", reason: "HARD_BOUNCE", source: "resend-webhook" }, // first reason kept
    ]);
    expect(await prisma.emailWebhookEvent.findMany({ orderBy: { eventId: "asc" }, select: { eventId: true, type: true, outcome: true } })).toEqual([
      { eventId: "msg_bounce_1", type: "email.bounced", outcome: "SUPPRESSED" },
      { eventId: "msg_complaint_1", type: "email.complained", outcome: "SUPPRESSED" },
    ]);
    spies.forEach((s) => s.mockRestore());
    expect(logs.join("\n")).not.toMatch(/example|msg_/i);
  });

  it("a non-permanent bounce, other event types and malformed payloads suppress nothing", async () => {
    expect((await webhook(bounced(["soft@example.com"], "Transient"))).body).toMatchObject({ outcome: "IGNORED" });
    expect((await webhook({ type: "email.delivered", data: { to: ["ok@example.com"] } })).body).toMatchObject({ outcome: "IGNORED" });
    expect((await webhook({ type: "email.bounced", data: { to: ["not an address"] } })).body).toMatchObject({ outcome: "IGNORED" });
    expect((await webhook(null, { body: "not json" })).status).toBe(400);
    expect(await prisma.globalEmailSuppression.count()).toBe(0);
  });

  it("a bounced address is excluded from every organization's next RSVP send", async () => {
    await confirmContacts();
    await webhook(bounced(["ben@example.com"]));
    const byId = Object.fromEntries(((await preview()).body.recipients as Body[]).map((r) => [r.playerId, r.status]));
    expect(byId.p2).toBe("SUPPRESSED");
    signIn("other");
    await putContact("q1", { email: "ben@example.com", type: "PLAYER", authorized: true }, "o2", "g2");
    expect(await post(send(1, "key-bounce-p6-01"), "m2", "o2", "g2")).toMatchObject({ status: 409, body: { code: "NOTHING_TO_SEND" } });
    expect(mailTo("ben@example.com")).toHaveLength(0);
  });
});
