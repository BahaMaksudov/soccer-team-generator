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
import * as cronRoute from "@/app/api/cron/automation/route";
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
  it("cutoff: a match on day D keeps its details through D+90 and loses direct identifiers from D+91 00:00Z", async () => {
    expect(retentionCutoff(new Date("2099-09-02T23:59:59Z")).toISOString()).toBe("2099-06-04T00:00:00.000Z");
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    expect(await runRsvpRetention({ now: LAST_RETAINED })).toMatchObject({ eligible: 0, identifiersRemoved: 0 });
    expect(await identifying()).toBe(3);
    const run = await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(run).toMatchObject({ eligible: 3, identifiersRemoved: 3, remaining: 0, activeSkipped: 0, concurrentRunDetected: false });
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
    expect(dry).toMatchObject({ dryRun: true, eligible: 6, identifiersRemoved: 0, batches: 0 });
    expect(await identifying()).toBe(6);
    const partial = await runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 2, maxBatches: 2 });
    expect(partial).toMatchObject({ identifiersRemoved: 4, batches: 2, remaining: 2 });
    const runs = await Promise.all([runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 1 }), runRsvpRetention({ now: FIRST_ANONYMIZED, batchSize: 1 })]);
    expect(runs[0].identifiersRemoved + runs[1].identifiersRemoved).toBe(2);
    expect(await runRsvpRetention({ now: FIRST_ANONYMIZED })).toMatchObject({ eligible: 0, identifiersRemoved: 0 });
    const stamps = await prisma.rsvpInvitation.findMany({ select: { identifiersRemovedAt: true } });
    expect(stamps.every((s) => s.identifiersRemovedAt?.getTime() === FIRST_ANONYMIZED.getTime())).toBe(true);
  });

  it("active delivery rows and incident holds are skipped and counted; a later match is untouched", async () => {
    await sendFor(O(), "m"); // stays QUEUED
    const held = await sendFor(O(), "mc");
    await sendFor(O(), "late");
    await processRsvpQueue({ now: SEND_AT, sendId: held.sendId });
    await processRsvpQueue({ now: SEND_AT, limit: 100, sendId: (await prisma.rsvpSend.findFirstOrThrow({ where: { matchId: "late" } })).id });
    await prisma.rsvpSend.update({ where: { id: held.sendId }, data: { retentionHoldUntil: new Date(FIRST_ANONYMIZED.getTime() + 7 * DAY) } });
    const run = await runRsvpRetention({ now: FIRST_ANONYMIZED });
    expect(run).toMatchObject({ identifiersRemoved: 0, activeSkipped: 3, heldForInvestigation: 3 });
    expect(await prisma.rsvpInvitation.count({ where: { matchId: "late", identifiersRemovedAt: null, email: { not: null } } })).toBe(3);
    // After the hold expires the held rows lose identifiers; QUEUED rows still never do.
    const after = await runRsvpRetention({ now: new Date(FIRST_ANONYMIZED.getTime() + 8 * DAY) });
    expect(after).toMatchObject({ identifiersRemoved: 3, activeSkipped: 3, heldForInvestigation: 0 });
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
    expect(await runRsvpRetention({ now: FIRST_ANONYMIZED })).toMatchObject({ identifiersRemoved: 6, remaining: 0 });
    expect(await prisma.rsvpEmailUsage.findMany()).toEqual(ledger);
    expect((await rsvpAllowance("o", SEND_AT)).day.used).toBe(9);
  });

  it("P8A: a deleted player's invitations lose their identifiers at the next run, whatever the match date", async () => {
    await sendFor(O(), "late");
    await processRsvpQueue({ now: SEND_AT });
    await prisma.player.delete({ where: { id: "p2" } });
    const run = await runRsvpRetention({ now: SEND_AT }); // long before the 90-day cutoff
    expect(run).toMatchObject({ eligibleDeletedPlayer: 1, identifiersRemoved: 1 });
    expect(await prisma.rsvpInvitation.findFirst({ where: { playerId: null } })).toMatchObject({ email: null, providerMessageId: null, idempotencyKey: null, unsubscribeTokenId: null });
    expect(await prisma.rsvpInvitation.count({ where: { playerId: { not: null }, email: { not: null } } })).toBe(2); // others untouched
  });

  it("P8A: after retention a row is de-identified, not anonymous — what remains linkable is exactly documented", async () => {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await runRsvpRetention({ now: FIRST_ANONYMIZED });
    const row = await prisma.rsvpInvitation.findFirstOrThrow({ where: { playerId: "p1" } });
    // Removed: the direct identifiers.
    expect(row).toMatchObject({ email: null, providerMessageId: null, idempotencyKey: null, unsubscribeTokenId: null });
    // Remaining (documented in docs/M13B_RSVP_EMAIL.md, P8A): links to the named player, match and organization, recipient type, status, dates.
    expect(row).toMatchObject({ playerId: "p1", matchId: "m", organizationId: "o", recipientType: "GUARDIAN", status: "SENT" });
    expect(row.sentAt).not.toBeNull();
    // The unsubscribe tokens still exist until they expire (old emails' links keep working), but are no longer linked to the invitation.
    expect(await prisma.emailUnsubscribeToken.count()).toBe(6);
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

  it("P8A: erasure without do-not-contact removes the address everywhere but never weakens or converts existing blocks", async () => {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await sendFor(O2(), "m2"); // still QUEUED for ben@
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "LINK" } });
    const r = await eraseRecipientEmail("  BEN@example.com ", { scope: { kind: "ALL" }, doNotContact: "NONE" });
    expect(r).toEqual({ ok: true, invitationsCleared: 2, queuedCanceled: 1, inFlight: 0, contactsCleared: 2, tokensDeleted: 2, organizationOptOutsKept: 1, organizationOptOut: "not-requested", globalSuppression: "not-requested" });
    expect(JSON.stringify(r)).not.toContain("@");
    expect(await prisma.rsvpInvitation.count({ where: { email: "ben@example.com" } })).toBe(0);
    expect(await prisma.rsvpInvitation.findFirst({ where: { organizationId: "o2" } })).toMatchObject({ status: "SKIPPED", skipReason: "RECIPIENT_REQUEST", email: null });
    expect((await rsvpAllowance("o2", SEND_AT)).day.used).toBe(0); // the canceled reservation is released
    expect(await prisma.player.findMany({ where: { id: { in: ["p2", "q1"] } }, select: { contactEmail: true, contactAuthorizedAt: true } })).toEqual([
      { contactEmail: null, contactAuthorizedAt: null },
      { contactEmail: null, contactAuthorizedAt: null },
    ]);
    // o's opt-out is kept AND stays organization-scoped; no global suppression was invented.
    expect(await prisma.organizationEmailOptOut.findMany({ select: { organizationId: true, email: true } })).toEqual([{ organizationId: "o", email: "ben@example.com" }]);
    expect(await prisma.globalEmailSuppression.count()).toBe(0);
    // Re-entered later: still blocked in o (its opt-out); o2 never had a block and none was added.
    await prisma.player.update({ where: { id: "p2" }, data: { contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o" } });
    await prisma.player.update({ where: { id: "q1" }, data: { contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o2" } });
    expect((await roster(O(), "m")).p2).toBe("SUPPRESSED");
    expect((await roster(O2(), "m2")).q1).toBe("WILL_SEND");
    expect(await eraseRecipientEmail("not an address", { scope: { kind: "ALL" }, doNotContact: "NONE" })).toEqual({ ok: false, code: "INVALID_EMAIL" });
  });

  it("P8A: a global do-not-contact must be explicit; repeated requests never remove it; bounces and complaints are preserved", async () => {
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ALL" }, doNotContact: "GLOBAL" })).toMatchObject({ globalSuppression: "added" });
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ALL" }, doNotContact: "NONE" })).toMatchObject({ globalSuppression: "existing" }); // a later request doesn't lift it
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ALL" }, doNotContact: "GLOBAL" })).toMatchObject({ globalSuppression: "existing" });
    expect(await prisma.globalEmailSuppression.findMany({ select: { email: true, reason: true } })).toEqual([{ email: "ben@example.com", reason: "RECIPIENT_REQUEST" }]);
    // An organizer re-entering the address (the erasure cleared it) still can't email it — in any organization.
    await prisma.player.update({ where: { id: "q1" }, data: { contactEmail: "ben@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH_AT, contactAuthorizedByUserId: "u-o2" } });
    expect((await roster(O2(), "m2")).q1).toBe("SUPPRESSED");
    await recordGlobalSuppression("angry@example.com", "SPAM_COMPLAINT", "resend-webhook");
    expect(await eraseRecipientEmail("angry@example.com", { scope: { kind: "ALL" }, doNotContact: "NONE" })).toMatchObject({ globalSuppression: "existing" });
    expect(await prisma.globalEmailSuppression.findUnique({ where: { email: "angry@example.com" }, select: { reason: true } })).toEqual({ reason: "SPAM_COMPLAINT" });
  });

  it("P8A: an organization-scoped request touches only that organization; its opt-out is organization-scoped", async () => {
    await sendFor(O(), "m");
    await sendFor(O2(), "m2");
    await processRsvpQueue({ now: SEND_AT, limit: 100 });
    const r = await eraseRecipientEmail("ben@example.com", { scope: { kind: "ORGANIZATION", organizationId: "o" }, doNotContact: "ORGANIZATION" });
    expect(r).toMatchObject({ ok: true, invitationsCleared: 1, contactsCleared: 1, tokensDeleted: 2, organizationOptOut: "added", globalSuppression: "not-requested" });
    expect(await prisma.rsvpInvitation.count({ where: { organizationId: "o2", email: "ben@example.com" } })).toBe(1); // o2 untouched
    expect(await prisma.player.findUniqueOrThrow({ where: { id: "q1" }, select: { contactEmail: true } })).toEqual({ contactEmail: "ben@example.com" });
    expect(await prisma.organizationEmailOptOut.findMany({ select: { organizationId: true, source: true } })).toEqual([{ organizationId: "o", source: "SUPPORT_REQUEST" }]);
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ORGANIZATION", organizationId: "o" }, doNotContact: "ORGANIZATION" })).toMatchObject({ organizationOptOut: "existing", organizationOptOutsKept: 1 });
    // Invalid combinations are refused.
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ALL" }, doNotContact: "ORGANIZATION" })).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ORGANIZATION", organizationId: "nope" }, doNotContact: "NONE" })).toEqual({ ok: false, code: "INVALID_REQUEST" });
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
    expect(await eraseRecipientEmail("ben@example.com", { scope: { kind: "ALL" }, doNotContact: "NONE" })).toMatchObject({ inFlight: 1, invitationsCleared: 0 });
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

describe("M13B release — retention through the automation cron (RSVP_RETENTION_MODE)", () => {
  const CRON = "a-long-enough-test-secret-for-retention";
  const cron = async (auth?: string) => {
    const r = await cronRoute.POST(new Request("http://itest.local/api/cron/automation", { method: "POST", headers: auth ? { authorization: auth } : {} }));
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line
  };
  const snapshot = async () => ({
    invitations: await prisma.rsvpInvitation.findMany({ orderBy: { id: "asc" } }),
    tokens: await prisma.emailUnsubscribeToken.count(),
    optOuts: await prisma.organizationEmailOptOut.findMany({ orderBy: { email: "asc" } }),
    suppressions: await prisma.globalEmailSuppression.findMany({ orderBy: { email: "asc" } }),
    answers: await prisma.attendanceResponse.findMany({ orderBy: { playerId: "asc" } }),
    usage: await prisma.rsvpEmailUsage.findMany(),
  });
  async function sentInvitations() {
    await sendFor(O(), "m");
    await processRsvpQueue({ now: SEND_AT });
    await prisma.organizationEmailOptOut.create({ data: { organizationId: "o", email: "ben@example.com", source: "LINK" } });
    await recordGlobalSuppression("guardian.of.ava@example.com", "HARD_BOUNCE", "itest");
    await prisma.attendanceResponse.create({ data: { matchId: "m", groupId: "g", playerId: "p2", participantStatus: "PLAYING", participantSource: "PERSONAL_LINK", participantRespondedAt: SEND_AT } });
    expect(await prisma.rsvpInvitation.count({ where: { status: { in: ["QUEUED", "SENDING"] } } })).toBe(0); // the cron's queue step has nothing to do
  }
  afterEach(() => vi.useRealTimers());

  it("unauthenticated calls never reach retention; dry-run reports counts and writes nothing", async () => {
    await sentInvitations();
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("RSVP_RETENTION_MODE", "run");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIRST_ANONYMIZED.getTime() + 9 * 3_600_000)); // 09:00 UTC, past the cutoff
    const before = await snapshot();
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong-secret-value-0000")).status).toBe(401);
    expect(await snapshot()).toEqual(before);

    vi.stubEnv("RSVP_RETENTION_MODE", "dry-run");
    const r = await cron(`Bearer ${CRON}`);
    expect(r.status).toBe(200);
    expect(r.body.retention).toMatchObject({ dryRun: true, eligible: 3, identifiersRemoved: 0, batches: 0, remaining: 3 });
    expect(JSON.stringify(r.body.retention)).not.toMatch(/@|Ava|Ben/);
    expect(await snapshot()).toEqual(before); // no database writes at all
  });

  it("run acts at any time of day (no 03:00 window), honors the 90-day cutoff, is idempotent, and keeps opt-outs, suppressions and answers", async () => {
    await sentInvitations();
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("RSVP_RETENTION_MODE", "run");
    vi.useFakeTimers({ toFake: ["Date"] });
    // Before the cutoff (D+90, 21:59 UTC): nothing is due.
    vi.setSystemTime(new Date(LAST_RETAINED.getTime() - 2 * 3_600_000));
    expect((await cron(`Bearer ${CRON}`)).body.retention).toMatchObject({ dryRun: false, eligible: 0, identifiersRemoved: 0 });
    expect(await identifying()).toBe(3);
    // After the cutoff, at an irregular scheduler time far from 03:00 UTC.
    vi.setSystemTime(new Date(FIRST_ANONYMIZED.getTime() + 21 * 3_600_000 + 59 * 60_000)); // D+91 21:59 UTC
    const before = await snapshot();
    const r = await cron(`Bearer ${CRON}`);
    expect(r.status).toBe(200);
    expect(r.body.retention).toMatchObject({ dryRun: false, identifiersRemoved: 3, remaining: 0, concurrentRunDetected: false });
    expect(await identifying()).toBe(0);
    const after = await snapshot();
    expect(after.optOuts).toEqual(before.optOuts);
    expect(after.suppressions).toEqual(before.suppressions);
    expect(after.answers).toEqual(before.answers);
    expect(after.usage).toEqual(before.usage);
    // Again: nothing more to do.
    expect((await cron(`Bearer ${CRON}`)).body.retention).toMatchObject({ eligible: 0, identifiersRemoved: 0 });
  });
});

