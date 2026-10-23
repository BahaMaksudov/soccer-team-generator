import { prisma } from "@/lib/prisma";
import { parseContactEmail } from "@/lib/emailAddress";

/**
 * M13B P7/P8A — retention and recipient erasure for RSVP invitation data. Not scheduled
 * anywhere: run explicitly (an operator, or a future approved job). Idempotent; reports
 * counts only — never an address, name or id.
 *
 * TERMINOLOGY (P8A): this REMOVES DIRECT IDENTIFIERS; it does not anonymize. After it runs,
 * an invitation row still links to its match, organization and — unless the player was
 * deleted — the named player, plus recipient type (player / guardian / account), delivery
 * status and dates. It therefore remains personal data while those records exist.
 *
 * runRsvpRetention — removes from invitations: the recipient address, the provider message
 * id, the idempotency key and the link to the unsubscribe token (identifiersRemovedAt is
 * stamped). Eligible rows:
 *   - invitations of matches dated more than RSVP_RETENTION_DAYS ago (UTC calendar days), and
 *   - at ANY age, invitations whose player was deleted (playerId set to null) — the address
 *     no longer serves the organizer and is removed at the next run.
 * NOT touched: attendance answers, the quota ledger (RsvpEmailUsage — address-free),
 * personal answer links (hash-only), opt-outs and suppressions (needed to keep honoring
 * them). Skipped and counted: QUEUED / SENDING rows (active processing) and sends under an
 * incident hold (RsvpSend.retentionHoldUntil in the future). Expired unsubscribe tokens
 * (they no longer work, and hold an address) are deleted.
 * Concurrency: transaction-scoped advisory lock per batch (a concurrent run stops) plus
 * FOR UPDATE SKIP LOCKED. Bounded batches; `dryRun` writes nothing.
 *
 * eraseRecipientEmail — a support-handled, identity-verified recipient request. See its doc.
 */
export const RSVP_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK = "rsvp-retention";
const ts = (d: Date) => d.toISOString();

/** First UTC day whose matches are still retained: a match on day D loses identifiers from D + RETENTION + 1 (00:00Z). */
export function retentionCutoff(now: Date, days = RSVP_RETENTION_DAYS): Date {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfToday - days * DAY_MS);
}

export type RetentionRun = {
  dryRun: boolean;
  cutoffDate: string; // matches dated before this UTC day are past retention
  eligible: number; // rows whose direct identifiers will be / were removed
  eligibleDeletedPlayer: number; // of which: player deleted (any match date)
  identifiersRemoved: number;
  heldForInvestigation: number;
  activeSkipped: number;
  expiredTokensEligible: number;
  expiredTokensDeleted: number;
  batches: number;
  remaining: number;
  concurrentRunDetected: boolean;
};

// $1 = now, $2 = cutoff (UTC ISO text). A row is due when its match is past retention or its player was deleted.
const DUE = `(m."date" < $2::timestamp OR i."playerId" IS NULL)`;
const NOT_HELD = `(s."retentionHoldUntil" IS NULL OR s."retentionHoldUntil" <= $1::timestamp)`;

export async function runRsvpRetention(opts: { now?: Date; dryRun?: boolean; batchSize?: number; maxBatches?: number; days?: number } = {}): Promise<RetentionRun> {
  const now = opts.now ?? new Date();
  const cutoff = retentionCutoff(now, opts.days);
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const maxBatches = Math.max(1, Math.min(opts.maxBatches ?? 20, 1000));
  const params = [ts(now), ts(cutoff)] as const;
  const counts = async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ eligible: bigint; deleted: bigint; held: bigint; active: bigint; tokens: bigint }>>(
      `SELECT
         count(*) FILTER (WHERE i."status" NOT IN ('QUEUED','SENDING') AND ${NOT_HELD})::bigint AS eligible,
         count(*) FILTER (WHERE i."status" NOT IN ('QUEUED','SENDING') AND ${NOT_HELD} AND i."playerId" IS NULL)::bigint AS deleted,
         count(*) FILTER (WHERE i."status" NOT IN ('QUEUED','SENDING') AND NOT ${NOT_HELD})::bigint AS held,
         count(*) FILTER (WHERE i."status" IN ('QUEUED','SENDING'))::bigint AS active,
         (SELECT count(*) FROM "EmailUnsubscribeToken" WHERE "expiresAt" < $1::timestamp)::bigint AS tokens
       FROM "RsvpInvitation" i JOIN "Match" m ON m."id" = i."matchId" JOIN "RsvpSend" s ON s."id" = i."sendId"
       WHERE i."anonymizedAt" IS NULL AND ${DUE}`,
      ...params
    );
    return { eligible: Number(row.eligible), deleted: Number(row.deleted), held: Number(row.held), active: Number(row.active), tokens: Number(row.tokens) };
  };

  const before = await counts();
  const run: RetentionRun = {
    dryRun: Boolean(opts.dryRun),
    cutoffDate: cutoff.toISOString().slice(0, 10),
    eligible: before.eligible,
    eligibleDeletedPlayer: before.deleted,
    identifiersRemoved: 0,
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
        `UPDATE "RsvpInvitation" SET "email" = NULL, "providerMessageId" = NULL, "idempotencyKey" = NULL, "unsubscribeTokenId" = NULL, "anonymizedAt" = $1::timestamp, "updatedAt" = $1::timestamp
         WHERE "id" IN (
           SELECT i."id" FROM "RsvpInvitation" i JOIN "Match" m ON m."id" = i."matchId" JOIN "RsvpSend" s ON s."id" = i."sendId"
           WHERE i."anonymizedAt" IS NULL AND ${DUE} AND i."status" NOT IN ('QUEUED','SENDING') AND ${NOT_HELD}
           ORDER BY i."id" LIMIT ${batchSize} FOR UPDATE OF i SKIP LOCKED)`,
        ...params
      );
      const tokens = await tx.$executeRawUnsafe(
        `DELETE FROM "EmailUnsubscribeToken" WHERE "id" IN (SELECT "id" FROM "EmailUnsubscribeToken" WHERE "expiresAt" < $1::timestamp ORDER BY "id" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)`,
        params[0]
      );
      return { invitations, tokens };
    });
    if (done === "busy") {
      run.concurrentRunDetected = true;
      break;
    }
    run.batches++;
    run.identifiersRemoved += done.invitations;
    run.expiredTokensDeleted += done.tokens;
    if (done.invitations < batchSize && done.tokens < batchSize) break;
  }
  run.remaining = (await counts()).eligible;
  return run;
}

// ------------------------------------------------------------------ recipient erasure (support only)

export type ErasureScope = { kind: "ALL" } | { kind: "ORGANIZATION"; organizationId: string };
/** What should block FUTURE invitations to this address — always an explicit choice. */
export type DoNotContact = "NONE" | "ORGANIZATION" | "GLOBAL";
export type ErasureResult =
  | { ok: false; code: "INVALID_EMAIL" | "INVALID_REQUEST" }
  | {
      ok: true;
      invitationsCleared: number;
      queuedCanceled: number;
      inFlight: number;
      contactsCleared: number;
      tokensDeleted: number;
      /** Existing per-organization opt-outs for the address (in scope) — never removed or converted. */
      organizationOptOutsKept: number;
      organizationOptOut: "added" | "existing" | "not-requested";
      globalSuppression: "added" | "existing" | "not-requested";
    };

/**
 * Support-handled request from a recipient whose control of the address was verified.
 *
 * Removes the address from RSVP data in `scope` (every organization, or ONE):
 *   - invitations: direct identifiers removed (as retention does); QUEUED ones are canceled
 *     first (never sent — reservation released); SENDING ones are in flight and only
 *     counted (run again after they settle);
 *   - unsubscribe tokens for the address;
 *   - organizer-entered player contacts with the address (and their confirmation record).
 *
 * Blocking future invitations is EXPLICIT (`doNotContact`) and never weakened:
 *   - "NONE"         — nothing new is recorded;
 *   - "ORGANIZATION" — an opt-out for that one organization (scope must be ORGANIZATION);
 *   - "GLOBAL"       — a RECIPIENT_REQUEST global suppression (every organization).
 * Existing organization opt-outs stay organization-scoped and are never deleted or turned
 * into a global suppression; existing global suppressions (bounce, complaint or an earlier
 * request) are never removed. Repeating a request changes nothing further. The address is
 * kept only where it is needed to keep blocking (opt-out / suppression rows: address,
 * organization or reason, source and date).
 * Linked accounts (User.email) are not touched; account deletion is a separate process.
 */
export async function eraseRecipientEmail(raw: string, opts: { scope: ErasureScope; doNotContact: DoNotContact; now?: Date }): Promise<ErasureResult> {
  const parsed = parseContactEmail(raw);
  if (!parsed.ok || !parsed.email) return { ok: false, code: "INVALID_EMAIL" };
  const { scope, doNotContact } = opts;
  if (!scope || !["NONE", "ORGANIZATION", "GLOBAL"].includes(doNotContact)) return { ok: false, code: "INVALID_REQUEST" };
  if (doNotContact === "ORGANIZATION" && scope.kind !== "ORGANIZATION") return { ok: false, code: "INVALID_REQUEST" };
  if (scope.kind === "ORGANIZATION" && !(await prisma.organization.findUnique({ where: { id: scope.organizationId }, select: { id: true } }))) return { ok: false, code: "INVALID_REQUEST" };
  const email = parsed.email;
  const now = opts.now ?? new Date();
  const org = scope.kind === "ORGANIZATION" ? { organizationId: scope.organizationId } : {};

  return prisma.$transaction(async (tx) => {
    const queued = await tx.rsvpInvitation.updateMany({ where: { ...org, email, status: "QUEUED" }, data: { status: "SKIPPED", skipReason: "RECIPIENT_REQUEST" } });
    const inFlight = await tx.rsvpInvitation.count({ where: { ...org, email, status: "SENDING" } });
    const cleared = await tx.rsvpInvitation.updateMany({
      where: { ...org, email, status: { not: "SENDING" } },
      data: { email: null, providerMessageId: null, idempotencyKey: null, unsubscribeTokenId: null, identifiersRemovedAt: now },
    });
    const tokens = await tx.emailUnsubscribeToken.deleteMany({ where: { ...org, email } });
    const contacts =
      scope.kind === "ORGANIZATION"
        ? await tx.$executeRaw`UPDATE "Player" p SET "contactEmail" = NULL, "contactEmailType" = NULL, "contactAuthorizedAt" = NULL, "contactAuthorizedByUserId" = NULL, "contactEmailUpdatedAt" = ${ts(now)}::timestamp
            FROM "Group" g WHERE g."id" = p."groupId" AND g."organizationId" = ${scope.organizationId} AND lower(p."contactEmail") = ${email}`
        : await tx.$executeRaw`UPDATE "Player" SET "contactEmail" = NULL, "contactEmailType" = NULL, "contactAuthorizedAt" = NULL, "contactAuthorizedByUserId" = NULL, "contactEmailUpdatedAt" = ${ts(now)}::timestamp WHERE lower("contactEmail") = ${email}`;
    const optOutsKept = await tx.organizationEmailOptOut.count({ where: { ...org, email } });

    let organizationOptOut: "added" | "existing" | "not-requested" = "not-requested";
    if (doNotContact === "ORGANIZATION" && scope.kind === "ORGANIZATION") {
      const r = await tx.organizationEmailOptOut.createMany({ data: [{ organizationId: scope.organizationId, email, source: "SUPPORT_REQUEST", optedOutAt: now }], skipDuplicates: true });
      organizationOptOut = r.count === 1 ? "added" : "existing";
    }
    const existingGlobal = await tx.globalEmailSuppression.findUnique({ where: { email }, select: { id: true } });
    const globalSuppression = existingGlobal ? "existing" : doNotContact === "GLOBAL" ? "added" : "not-requested";
    if (globalSuppression === "added") await tx.globalEmailSuppression.create({ data: { email, reason: "RECIPIENT_REQUEST", source: "privacy-request" } });

    return {
      ok: true as const,
      invitationsCleared: cleared.count,
      queuedCanceled: queued.count,
      inFlight,
      contactsCleared: contacts,
      tokensDeleted: tokens.count,
      organizationOptOutsKept: optOutsKept, // counted before any new opt-out below
      organizationOptOut,
      globalSuppression,
    };
  });
}
