import { prisma } from "@/lib/prisma";
import { parseContactEmail } from "@/lib/emailAddress";

/**
 * M13B P7 — retention for RSVP invitation data. Not scheduled anywhere: run explicitly
 * (an operator, or a future approved job). Everything here is idempotent and reports
 * counts only — never an address, name or id.
 *
 * runRsvpRetention — invitations of matches that took place more than
 * RSVP_RETENTION_DAYS ago (UTC calendar days after the match date) lose their identifying
 * delivery details: the recipient address, the provider message id and the idempotency
 * key. Status, round, timestamps, skip reason, error category and the player reference
 * stay, so the organizer's history keeps its shape. NOT touched: attendance answers
 * (AttendanceResponse), the quota ledger (RsvpEmailUsage — already address-free),
 * personal answer links (hash-only), opt-outs and suppressions (needed to keep honoring
 * them). Skipped and counted:
 *   - rows still QUEUED / SENDING (active delivery processing);
 *   - rows of a send under an incident hold (RsvpSend.retentionHoldUntil in the future).
 * Expired unsubscribe tokens (they no longer work, and hold an address) are deleted.
 * Deleted matches need nothing: their invitations were removed with them (cascade), and
 * their quota usage stays in the ledger.
 * Concurrency: each batch takes a transaction-scoped advisory lock (a second concurrent
 * run stops instead of competing) and claims rows with FOR UPDATE SKIP LOCKED. Bounded:
 * `batchSize` rows per batch, at most `maxBatches` batches per run. `dryRun` writes nothing.
 *
 * eraseRecipientEmail — a support-handled privacy request from a recipient (see
 * docs/M13B_PILOT_READINESS.md). Removes the address everywhere RSVP email stored it and,
 * by default, keeps ONE global suppression so no organization can email it again.
 * There is no organizer-facing way to lift a suppression or opt-out.
 */
export const RSVP_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK = "rsvp-retention";
const ts = (d: Date) => d.toISOString();

/** First UTC day whose matches are still retained: a match on day D is anonymized from D + RETENTION + 1 (00:00Z). */
export function retentionCutoff(now: Date, days = RSVP_RETENTION_DAYS): Date {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfToday - days * DAY_MS);
}

export type RetentionRun = {
  dryRun: boolean;
  cutoffDate: string; // matches dated before this UTC day are past retention
  eligible: number;
  anonymized: number;
  heldForInvestigation: number;
  activeSkipped: number;
  expiredTokensEligible: number;
  expiredTokensDeleted: number;
  batches: number;
  remaining: number;
  concurrentRunDetected: boolean;
};

const PAST = `m."date" < $2::timestamp`; // $1 = now, $2 = cutoff (ISO text, UTC)

export async function runRsvpRetention(opts: { now?: Date; dryRun?: boolean; batchSize?: number; maxBatches?: number; days?: number } = {}): Promise<RetentionRun> {
  const now = opts.now ?? new Date();
  const cutoff = retentionCutoff(now, opts.days);
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? 20, 1000));
  const nowTs = ts(now);
  // now / cutoff are bound parameters (UTC ISO text); batchSize is a clamped integer.
  const counts = async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ eligible: bigint; held: bigint; active: bigint; tokens: bigint }>>(
      `SELECT
         count(*) FILTER (WHERE i."status" NOT IN ('QUEUED','SENDING') AND (s."retentionHoldUntil" IS NULL OR s."retentionHoldUntil" <= $1::timestamp))::bigint AS eligible,
         count(*) FILTER (WHERE i."status" NOT IN ('QUEUED','SENDING') AND s."retentionHoldUntil" > $1::timestamp)::bigint AS held,
         count(*) FILTER (WHERE i."status" IN ('QUEUED','SENDING'))::bigint AS active,
         (SELECT count(*) FROM "EmailUnsubscribeToken" WHERE "expiresAt" < $1::timestamp)::bigint AS tokens
       FROM "RsvpInvitation" i JOIN "Match" m ON m."id" = i."matchId" JOIN "RsvpSend" s ON s."id" = i."sendId"
       WHERE i."anonymizedAt" IS NULL AND ${PAST}`,
      nowTs,
      ts(cutoff)
    );
    return { eligible: Number(row.eligible), held: Number(row.held), active: Number(row.active), tokens: Number(row.tokens) };
  };

  const before = await counts();
  const run: RetentionRun = {
    dryRun: Boolean(opts.dryRun),
    cutoffDate: cutoff.toISOString().slice(0, 10),
    eligible: before.eligible,
    anonymized: 0,
    heldForInvestigation: before.held,
    activeSkipped: before.active,
    expiredTokensEligible: before.tokens,
    expiredTokensDeleted: 0,
    batches: 0,
    remaining: before.eligible,
    concurrentRunDetected: false,
  };
  if (opts.dryRun) return run;

  for (let b = 0; b < maxBatches; b++) {
    const done = await prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK})) AS locked`;
      if (!locked) return "busy" as const;
      const invitations = await tx.$executeRawUnsafe(
        `UPDATE "RsvpInvitation" SET "email" = NULL, "providerMessageId" = NULL, "idempotencyKey" = NULL, "anonymizedAt" = $1::timestamp, "updatedAt" = $1::timestamp
         WHERE "id" IN (
           SELECT i."id" FROM "RsvpInvitation" i JOIN "Match" m ON m."id" = i."matchId" JOIN "RsvpSend" s ON s."id" = i."sendId"
           WHERE i."anonymizedAt" IS NULL AND ${PAST} AND i."status" NOT IN ('QUEUED','SENDING')
             AND (s."retentionHoldUntil" IS NULL OR s."retentionHoldUntil" <= $1::timestamp)
           ORDER BY i."id" LIMIT ${batchSize} FOR UPDATE OF i SKIP LOCKED)`,
        nowTs,
        ts(cutoff)
      );
      const tokens = await tx.$executeRawUnsafe(
        `DELETE FROM "EmailUnsubscribeToken" WHERE "id" IN (SELECT "id" FROM "EmailUnsubscribeToken" WHERE "expiresAt" < $1::timestamp ORDER BY "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)`,
        nowTs
      );
      return { invitations, tokens };
    });
    if (done === "busy") {
      run.concurrentRunDetected = true;
      break;
    }
    run.batches++;
    run.anonymized += done.invitations;
    run.expiredTokensDeleted += done.tokens;
    if (done.invitations < batchSize && done.tokens < batchSize) break;
  }
  run.remaining = (await counts()).eligible;
  return run;
}

export type ErasureResult =
  | { ok: false; code: "INVALID_EMAIL" }
  | { ok: true; invitationsAnonymized: number; queuedCanceled: number; inFlight: number; contactsCleared: number; tokensDeleted: number; optOutsReplaced: number; globalSuppression: "kept" | "added" | "removed" | "none" };

/**
 * Support-handled privacy request: erase one recipient address from RSVP email data.
 *   - invitation rows with the address: details removed (as retention does); QUEUED rows
 *     are skipped first (never sent — reservation released); a SENDING row is in flight and
 *     only counted (it settles within minutes; run again afterwards);
 *   - unsubscribe tokens for the address: deleted;
 *   - organizer-entered player contacts with the address: cleared (with their confirmation);
 *   - suppression: by default ONE global RECIPIENT_REQUEST suppression replaces this
 *     address's per-organization opt-outs, so it stays blocked everywhere with the least
 *     data kept. `keepSuppression: false` (an owner decision per request) drops that too —
 *     then an organizer could enter the address again later. A hard-bounce or complaint
 *     suppression is ALWAYS kept (sender reputation; it holds only the address and reason).
 * Linked accounts (User.email) are not touched; account deletion is a separate process.
 */
export async function eraseRecipientEmail(raw: string, opts: { now?: Date; keepSuppression?: boolean } = {}): Promise<ErasureResult> {
  const parsed = parseContactEmail(raw);
  if (!parsed.ok || !parsed.email) return { ok: false, code: "INVALID_EMAIL" };
  const email = parsed.email;
  const now = opts.now ?? new Date();
  const keep = opts.keepSuppression ?? true;
  return prisma.$transaction(async (tx) => {
    const queued = await tx.rsvpInvitation.updateMany({ where: { email, status: "QUEUED" }, data: { status: "SKIPPED", skipReason: "RECIPIENT_REQUEST" } });
    const inFlight = await tx.rsvpInvitation.count({ where: { email, status: "SENDING" } });
    const anonymized = await tx.rsvpInvitation.updateMany({ where: { email, status: { not: "SENDING" } }, data: { email: null, providerMessageId: null, idempotencyKey: null, anonymizedAt: now } });
    const tokens = await tx.emailUnsubscribeToken.deleteMany({ where: { email } });
    const contacts = await tx.$executeRaw`UPDATE "Player" SET "contactEmail" = NULL, "contactEmailType" = NULL, "contactAuthorizedAt" = NULL, "contactAuthorizedByUserId" = NULL, "contactEmailUpdatedAt" = ${ts(now)}::timestamp WHERE lower("contactEmail") = ${email}`;
    const optOuts = await tx.organizationEmailOptOut.deleteMany({ where: { email } });
    const existing = await tx.globalEmailSuppression.findUnique({ where: { email }, select: { reason: true } });
    let globalSuppression: "kept" | "added" | "removed" | "none";
    if (keep) {
      if (existing) globalSuppression = "kept";
      else {
        await tx.globalEmailSuppression.create({ data: { email, reason: "RECIPIENT_REQUEST", source: "privacy-request" } });
        globalSuppression = "added";
      }
    } else if (existing?.reason === "RECIPIENT_REQUEST") {
      await tx.globalEmailSuppression.delete({ where: { email } });
      globalSuppression = "removed";
    } else globalSuppression = existing ? "kept" : "none"; // hard bounces / complaints always stay (sender reputation)
    return { ok: true as const, invitationsAnonymized: anonymized.count, queuedCanceled: queued.count, inFlight, contactsCleared: contacts, tokensDeleted: tokens.count, optOutsReplaced: optOuts.count, globalSuppression };
  });
}
