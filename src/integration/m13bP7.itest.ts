/**
 * M13B P7 — invitation retention, privacy erasure, suppression / deletion consistency and
 * webhook edge cases. REAL DATABASE (guarded local test DB only). Delivery goes to the
 * in-memory test outbox only; network is forbidden (global fetch throws and is counted).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { createRsvpSend, processRsvpQueue, setRsvpTransportForTests } from "@/lib/rsvpSend";
import { classifyRoster, MATCH_SELECT, rsvpAllowance } from "@/lib/rsvpPreview";
import { rsvpStatusView } from "@/lib/rsvpStatus";
import { eraseRecipientEmail, retentionCutoff, runRsvpRetention, RSVP_RETENTION_DAYS } from "@/lib/rsvpRetention";
import { recordGlobalSuppression } from "@/lib/emailSuppression";
import { signWebhookForTests } from "@/lib/webhookSignature";
import * as webhookRoute from "@/app/api/email/webhooks/resend/route";
import { EmailDeliveryError, testOutbox } from "@/lib/email/transport";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const TZ = "America/New_York";
const AUTH_AT = new Date("2026-01-01T00:00:00Z");
const MATCH_DAY = new Date("2099-06-03T00:00:00Z");
const DAY = 86_400_000;
const LAST_RETAINED = new Date(MATCH_DAY.getTime() + (RSVP_RETENTION_DAYS + 1) * DAY - 1); // D+90, 23:59:59.999Z
const FIRST_ANONYMIZED = new Date(MATCH_DAY.getTime() + (RSVP_RETENTION_DAYS + 1) * DAY); // D+91, 00:00Z
const SEND_AT = new Date("2099-06-01T12:00:00Z");
const WH_SECRET = "whsec_" + Buffer.alloc(32, 5).toString("base64");
let network = 0;
const originalFetch = global.fetch;

const ctx = (organizationId: string, groupId: string): TenantContext => {
  const group = { id: groupId, name: groupId, slug: groupId, sportKey: "soccer", timezone: TZ };
  return { user: { id: `u-${organizationId}`, email: "x@example.test", name: "x" }, organization: { id: organizationId, name: organizationId, slug: organizationId }, membership: { id: "m", role: "OWNER" }, groups: [group], activeGroup: group };
};
const O = () => ctx("o", "g");
const O2 = () => ctx("o2", "g2");
let keyN = 0;
const sendFor = async (c: TenantContext, matchId: string, kind: "INITIAL" | "RESEND" = "INITIAL") => {
  const r = await createRsvpSend(c, matchId, { kind, requestKey: `key-p7-${String(++keyN).padStart(6, "0")}` }, SEND_AT);
  if (!r.ok) throw new Error(`send refused: ${r.code}`);
  return r;
};
const identifying = () => prisma.rsvpInvitation.count({ where: { OR: [{ email: { not: null } }, { providerMessageId: { not: null } }, { idempotencyKey: { not: null } }] } });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EmailWebhookEvent","RsvpEmailUsage","RsvpInvitation","RsvpSend","EmailUnsubscribeToken","OrganizationEmailOptOut","GlobalEmailSuppression","PersonalAttendanceLink","AttendanceResponse","TelegramPoll","TelegramChat","Match","CommunityPlayer","Community","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["o", "o2", "linked"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "o", name: "Wednesday Club", slug: "o", plan: "LEGACY" }, { id: "o2", name: "Other Club", slug: "o2", plan: "LEGACY" }] });
  await prisma.group.createMany({ data: [{ id: "g", organizationId: "o", name: "Wednesday", slug: "g", sportKey: "soccer", timezone: TZ }, { id: "g2", organizationId: "o2", name: "Other", slug: "g2", sportKey: "soccer", timezone: TZ }] });
  await prisma.organizationMembership.createMany({ data: [{ userId: "u-o", organizationId: "o", role: "OWNER" }, { userId: "u-o2", organizationId: "o2", role: "OWNER" }] });
  const P = (id: string, groupId: string, firstName: string, email: string | null, type: "PLAYER" | "GUARDIAN" = "PLAYER", extra: Record<string, unknown> = {}) => ({
    id, groupId, firstName, lastName: "Test", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3,
    ...(email ? { contactEmail: email, contactEmailType: type, contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: `u-${groupId === "g" ? "o" : "o2"}` } : {}),
    ...extra,
  });
  await prisma.player.createMany({
    data: [
      P("p1", "g", "Ava", "guardian.of.ava@example.com", "GUARDIAN"),
      P("p2", "g", "Ben", "ben@example.com"),
      P("p3", "g", "Cal", null, "PLAYER", { userId: "u-linked" }),
      P("q1", "g2", "Quinn", "ben@example.com"), // the same address in another organization
    ],
  });
  await prisma.match.createMany({
    data: [
      { id: "m", groupId: "g", date: MATCH_DAY },
      { id: "mc", groupId: "g", date: MATCH_DAY },
      { id: "mx", groupId: "g", date: MATCH_DAY },
      { id: "late", groupId: "g", date: new Date(MATCH_DAY.getTime() + 30 * DAY) },
      { id: "m2", groupId: "g2", date: MATCH_DAY },
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
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@tbp.itest>");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WH_SECRET);
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

describe("M13B P7 — retention cutoff (UTC) and what is kept", () => {
  it("cutoff: a match on day D keeps its details through D+90 and is anonymized from D+91 00:00Z", async () => {
    expect(retentionCutoff(new Date("2099-09-02T23:59:59Z")).toISOString()).toBe("2099-06-04T00:00:00.000Z");
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    expect(await runRsvpRetention({ now: LAST_RETAINED })).toMatchObject({ eligible: 0, anonymized: 0 });
    expect(await identifying()).toBe(3);
    const run = await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(run).toMatchObject({ eligible: 3, anonymized: 3, remaining: 0, activeSkipped: 0, concurrentRunDetected: false });
    expect(await identifying()).toBe(0);
    expect(JSON.stringify(run)).not.toMatch(/@|Ava|Ben/);
  });

  it("keeps status, rounds, timestamps, answers, the quota ledger and the dashboard shape", async () => {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: SEND_AT } });
    const answersBefore = await prisma.attendanceResponse.findMany();
    const ledgerBefore = await prisma.rsvpEmailUsage.findMany();
    const before = await prisma.rsvpInvitation.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, round: true, sentAt: true, playerId: true, recipientType: true, linkId: true } });
    await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(await prisma.rsvpInvitation.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, round: true, sentAt: true, playerId: true, recipientType: true, linkId: true } })).toEqual(before);
    expect(await prisma.attendanceResponse.findMany()).toEqual(answersBefore);
    expect(await prisma.rsvpEmailUsage.findMany()).toEqual(ledgerBefore);
    expect((await rsvpAllowance("o", SEND_AT)).day.used).toBe(3);
    const view = await rsvpStatusView(O(), "m");
    expect(view!.totals.delivery.accepted).toBe(3);
    expect(view!.recipients.every((r) => r.maskedEmail === null && r.at.accepted !== null)).toBe(true);
    expect(view!.totals.rsvp.yes).toBe(1);
  });

  it("idempotent; concurrent runs never double-process; dry run writes nothing; bounded batches", async () => {
    await sendFor(O(), "m");
    await sendFor(O(), "mc");
    await processRsvpQueue({ now: SEND_AT, limit: 100 });
    const dry = await runRsvpRetention({ now: FIRST_ANONYMIZED, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, eligible: 6, anonymized: 0, batches: 0 });
    expect(await identifying()).toBe(6);
    const partial = await runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 2, maxBatches: 2 });
    expect(partial).toMatchObject({ anonymized: 4, batches: 2, remaining: 2 });
    const runs = await Promise.all([runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 1 }), runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 1 })]);
    expect(runs[0].anonymized + runs[1].anonymized).toBe(2);
    expect(await runRsvpRetention({ now: FIRST_ANONYMIZED })).toMatchObject({ eligible: 0, anonymized: 0 });
    const stamps = await prisma.rsvpInvitation.findMany({ select: { anonymizedAt: true } });
    expect(stamps.every((s) => s.anonymizedAt?.getTime() === FIRST_ANONYMIZED.getTime())).toBe(true);
  });

  it("active delivery rows and incident holds are skipped and counted; a later match is untouched", async () => {
    await sendFor(O(), "m"); // stays QUEUED
    const held = await sendFor(O(), "mc");
    await sendFor(O(), "late");
    await processRsvpQueue({ now: SEND_AT, sendId: held.sendId });
    await processRsvpQueue({ now: SEND_AT, limit: 100, sendId: (await prisma.rsvpSend.findFirstOrThrow({ where: { matchId: "late" } })).id });
    await prisma.rsvpSend.update({ where: { id: held.sendId }, data: { retentionHoldUntil: new Date(FIRST_ANONYMIZED.getTime() + 7 * DAY) } });
    const run = await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(run).toMatchObject({ anonymized: 0, activeSkipped: 3, heldForInvestigation: 3 });
    expect(await prisma.rsvpInvitation.count({ where: { matchId: "late", anonymizedAt: null, email: { not: null } } })).toBe(3);
    // After the hold expires the held rows are anonymized; QUEUED rows still never are.
    const after = await runRsvpRetention({ now: new Date(FIRST_ANONYMIZED.getTime() + 8 * DAY) });
    expect(after).toMatchObject({ anonymized: 3, activeSkipped: 3, heldForInvestigation: 0 });
  });

  it("completed, canceled and deleted matches", async () => {
    await sendFor(O(), "m");
    await sendFor(O(), "mc");
    await sendFor(O(), "mx");
    await processRsvpQueue({ now: SEND_AT, limit: 100 });
    await prisma.match.update({ where: { id: "m" }, data: { status: "COMPLETED" } });
    await prisma.match.update({ where: { id: "mc" }, data: { status: "CANCELED" } });
    const ledger = await prisma.rsvpEmailUsage.findMany();
    await prisma.match.delete({ where: { id: "mx" } }); // invitations go with it; the ledger stays
    expect(await prisma.rsvpInvitation.count({ where: { matchId: "mx" } })).toBe(0);
    expect(await runRsvpRetention({ now: FIRST_ANONYMIZED })).toMatchObject({ anonymized: 6, remaining: 0 });
    expect(await prisma.rsvpEmailUsage.findMany()).toEqual(ledger);
    expect((await rsvpAllowance("o", SEND_AT)).day.used).toBe(9);
  });

  it("expired unsubscribe tokens (they hold an address) are deleted; opt-outs stay", async () => {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "LINK" } });
    expect(await prisma.emailUnsubscribeToken.count()).toBe(6); // page + one-click per email
    const run = await runRsvpRetention({ now: new Date(SEND_AT.getTime() + 366 * DAY) });
    expect(run).toMatchObject({ expiredTokensEligible: 6, expiredTokensDeleted: 6 });
    expect(await prisma.emailUnsubscribeToken.count()).toBe(0);
    expect(await prisma.rsvpInvitation.count({ where: { unsubscribeTokenId: { not: null } } })).toBe(0);
    expect(await prisma.organizationEmailOptOut.count()).toBe(1);
  });

  it("retention never touches another tenant's recent data", async () => {
    await prisma.match.update({ where: { id: "m2" }, data: { date: new Date(MATCH_DAY.getTime() + 60 * DAY) } });
    await sendFor(O(), "m");
    await sendFor(O2(), "m2");
    await processRsvpQueue({ now: SEND_AT, limit: 100 });
    await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(await prisma.rsvpInvitation.count({ where: { organizationId: "o2", email: { not: null } } })).toBe(1);
    expect(await prisma.rsvpInvitation.count({ where: { organizationId: "o", email: { not: null } } })).toBe(0);
  });
});

describe("M13B P7 — privacy erasure and suppression consistency", () => {
  const roster = async (c: TenantContext, matchId: string) => {
    const match = await prisma.match.findFirstOrThrow({ where: { id: matchId }, select: MATCH_SELECT });
    return Object.fromEntries((await classifyRoster(c.organization.id, match, 100)).rows.map((r) => [r.playerId, r.status]));
  };

  it("erasing an address: invitations anonymized, queued ones canceled, contacts cleared everywhere, one global suppression kept", async () => {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await sendFor(O2(), "m2"); // still QUEUED for ben@
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "LINK" } });
    const r = await eraseRecipientEmail("  BEN@example.com ");
    expect(r).toEqual({ ok: true, invitationsAnonymized: 2, queuedCanceled: 1, inFlight: 0, contactsCleared: 2, tokensDeleted: 2, optOutsReplaced: 1, globalSuppression: "added" });
    expect(JSON.stringify(r)).not.toContain("@");
    expect(await prisma.rsvpInvitation.count({ where: { email: "ben@example.com" } })).toBe(0);
    expect(await prisma.rsvpInvitation.findFirst({ where: { organizationId: "o2" } })).toMatchObject({ status: "SKIPPED", skipReason: "RECIPIENT_REQUEST", email: null });
    expect((await rsvpAllowance("o2", SEND_AT)).day.used).toBe(0); // the canceled reservation is released
    expect(await prisma.player.findMany({ where: { id: { in: ["p2", "q1"] } }, select: { contactEmail: true, contactAuthorizedAt: true } })).toEqual([
      { contactEmail: null, contactAuthorizedAt: null },
      { contactEmail: null, contactAuthorizedAt: null },
    ]);
    expect(await prisma.organizationEmailOptOut.count()).toBe(0);
    expect(await prisma.globalEmailSuppression.findMany({ select: { email: true, reason: true } })).toEqual([{ email: "ben@example.com", reason: "RECIPIENT_REQUEST" }]);
    // Any organizer re-entering the address still can't email it.
    await prisma.player.update({ where: { id: "q1" }, data: { contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o2" } });
    expect((await roster(O2(), "m2")).q1).toBe("SUPPRESSED");
    expect(await eraseRecipientEmail("ben@example.com")).toMatchObject({ ok: true, globalSuppression: "kept" }); // idempotent
    expect(await eraseRecipientEmail("not an address")).toEqual({ ok: false, code: "INVALID_EMAIL" });
  });

  it("keepSuppression:false forgets a recipient-request suppression but never a hard bounce", async () => {
    await eraseRecipientEmail("ben@example.com");
    expect(await eraseRecipientEmail("ben@example.com", { keepSuppression: false })).toMatchObject({ globalSuppression: "removed" });
    expect(await prisma.globalEmailSuppression.count()).toBe(0);
    await recordGlobalSuppression("ben@example.com", "HARD_BOUNCE", "resend-webhook");
    expect(await eraseRecipientEmail("ben@example.com", { keepSuppression: false })).toMatchObject({ globalSuppression: "kept" });
    expect(await prisma.globalEmailSuppression.findMany({ select: { reason: true } })).toEqual([{ reason: "HARD_BOUNCE" }]);
  });

  it("deletion consistency: deleting a player keeps the address's opt-out; deleting an organization removes only its own opt-outs; global suppressions stay", async () => {
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "LINK" } });
    await recordGlobalSuppression("guardian.of.ava@example.com", "SPAM_COMPLAINT", "resend-webhook");
    await prisma.player.delete({ where: { id: "p2" } });
    await prisma.player.create({ data: { id: "p9", groupId: "g", firstName: "Ben", lastName: "Again", position: "MIDFIELDER", rating: "GOOD", stamina: 3, contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o" } });
    expect(await roster(O(), "m")).toMatchObject({ p9: "SUPPRESSED", p1: "SUPPRESSED" });
    // A changed contact: the old address's opt-out doesn't block the new address.
    await prisma.player.update({ where: { id: "p9" }, data: { contactEmail: "ben.new@example.com" } });
    expect((await roster(O(), "m")).p9).toBe("WILL_SEND");
    // Organization deletion (groups RESTRICT while they have players/matches, so it is emptied first, as an operator would).
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o2", email: "quinn.parent@example.com", source: "ONE_CLICK" } });
    await prisma.player.deleteMany({ where: { groupId: "g2" } });
    await prisma.match.deleteMany({ where: { groupId: "g2" } });
    await prisma.group.delete({ where: { id: "g2" } });
    await prisma.organization.delete({ where: { id: "o2" } });
    expect(await prisma.organizationEmailOptOut.findMany({ select: { organizationId: true } })).toEqual([{ organizationId: "o" }]); // o2's own records went with it
    expect(await prisma.globalEmailSuppression.count()).toBe(1);
  });

  it("an in-flight (SENDING) invitation is reported, not silently erased", async () => {
    await sendFor(O(), "m");
    await prisma.rsvpInvitation.updateMany({ where: { email: "ben@example.com" }, data: { status: "SENDING", claimedAt: SEND_AT, attempts: 1 } });
    expect(await eraseRecipientEmail("ben@example.com")).toMatchObject({ inFlight: 1, invitationsAnonymized: 0 });
    expect(await prisma.rsvpInvitation.count({ where: { email: "ben@example.com", status: "SENDING" } })).toBe(1);
  });
});

describe("M13B P7 — guardian authorization (re-check)", () => {
  it("an unconfirmed guardian contact is never queued or emailed; confirming it later makes it eligible", async () => {
    await prisma.player.update({ where: { id: "p1" }, data: { contactAuthorizedAt: null, contactAuthorizedByUserId: null } });
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    expect(testOutbox.sent.map((m) => m.to).sort()).toEqual(["ben@example.com", "linked@example.test"]);
    expect(await prisma.rsvpInvitation.findFirst({ where: { playerId: "p1" } })).toMatchObject({ status: "SKIPPED", skipReason: "CONTACT_UNCONFIRMED", email: null, recipientType: "GUARDIAN" });
    await prisma.player.update({ where: { id: "p1" }, data: { contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o" } });
    await sendFor(O(), "m", "RESEND");
    await processRsvpQueue({ now: SEND_AT });
    expect(testOutbox.sent.filter((m) => m.to === "guardian.of.ava@example.com")).toHaveLength(1);
  });

  it("a failed then retried email never reaches an address changed in between", async () => {
    setRsvpTransportForTests({ name: "reject", send: async () => Promise.reject(new EmailDeliveryError("http", 400)) });
    const s = await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    setRsvpTransportForTests(null);
    await prisma.player.update({ where: { id: "p1" }, data: { contactEmail: "new.guardian@example.com", contactAuthorizedAt: AUTH_AT } });
    await prisma.rsvpInvitation.updateMany({ where: { sendId: s.sendId, status: "FAILED" }, data: { status: "QUEUED", reservedAt: SEND_AT } }); // as a retry would
    await processRsvpQueue({ now: SEND_AT });
    expect(testOutbox.sent.map((m) => m.to)).not.toContain("guardian.of.ava@example.com");
    expect(await prisma.rsvpInvitation.findFirst({ where: { playerId: "p1" } })).toMatchObject({ status: "SKIPPED", skipReason: "CONTACT_CHANGED" });
  });
});

describe("M13B P7 — webhook edge cases", () => {
  const post = async (body: string | ReadableStream<Uint8Array>, headers: Record<string, string>) => {
    const r = await webhookRoute.POST(new Request("http://itest.local/api/email/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ...(typeof body === "string" ? {} : { duplex: "half" }) } as RequestInit));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const signed = (body: string, id = "msg_edge_1", at = Math.floor(Date.now() / 1000)) => ({ "svix-id": id, "svix-timestamp": String(at), "svix-signature": signWebhookForTests(WH_SECRET, id, String(at), body) });

  it("oversized bodies are refused before verification, with or without Content-Length", async () => {
    const big = "x".repeat(300 * 1024);
    expect((await post(big, { ...signed(big), "content-length": String(big.length) })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(8 * 1024).fill(120));
        c.close();
      },
    });
    expect((await post(stream, { "svix-id": "msg_s", "svix-timestamp": "1", "svix-signature": "v1,x" })).status).toBe(413);
    expect(await prisma.emailWebhookEvent.count()).toBe(0);
  });

  it("malformed event ids are refused; a key-rotation signature list verifies; replays stay single", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { to: ["angry@example.com"] } });
    expect((await post(body, signed(body, "msg bad id"))).status).toBe(401);
    expect((await post(body, signed(body, "x".repeat(200)))).status).toBe(401);
    const h = signed(body, "msg_rotate");
    const rotated = { ...h, "svix-signature": `v1,${Buffer.alloc(32, 1).toString("base64")} ${h["svix-signature"]}` };
    expect(await post(body, rotated)).toMatchObject({ status: 200, body: { status: "processed" } });
    expect(await post(body, rotated)).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect(await prisma.globalEmailSuppression.count()).toBe(1);
  });
});
