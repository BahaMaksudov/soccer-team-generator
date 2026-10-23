import { Prisma, type RsvpSendKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { generateToken, hashToken } from "@/lib/secureToken";
import { lockMatchForAnswer } from "@/lib/attendanceClosure";
import { PERSONAL_ATTENDANCE_PATH } from "@/lib/personalAttendance";
import { suppressedFor, unsubscribeLinks, oneClickUnsubscribeHeaders, UNSUBSCRIBE_TOKEN_TTL_DAYS } from "@/lib/emailSuppression";
import { classifyRoster, matchRefusal, pilotGlobalRemaining, rsvpAllowance, MATCH_SELECT, type PreviewRefusal } from "@/lib/rsvpPreview";
import { appUrl, getEmailFrom, EmailConfigError } from "@/lib/email/config";
import { createRsvpResendTransport, EmailDeliveryError, testOutbox, type EmailTransport } from "@/lib/email/transport";
import { buildRsvpInvitationEmail } from "@/lib/email/templates";
import { pilotOrganizations, rsvpDeliveryAllowedFor, rsvpDeliveryMode } from "@/lib/rsvpDeliveryMode";
import { resolveRecipient } from "@/lib/playerContact";
import { normalizeEmail } from "@/lib/emailAddress";
import { formatStartTime } from "@/lib/messaging/content";
import { formatDeadline } from "@/lib/deadlineFormat";

/**
 * M13B P4 — the RSVP email SENDING ENGINE (no HTTP route; not callable from the UI).
 *
 * DELIVERY GATE, enforced here on the server (src/lib/rsvpDeliveryMode.ts):
 *   test-outbox — the in-memory outbox (automated tests / confirmed local test env);
 *   live        — P8A Resend pilot: Production only, an exact opt-in flag, a pilot
 *                 organization allowlist, a validated sender, pilot limits. DEFAULT OFF:
 *                 no environment has the flag;
 *   disabled    — everything else: rsvpTransport() throws RsvpDeliveryDisabledError BEFORE
 *                 anything is queued or claimed.
 * Account / security emails never use this module's transport (src/lib/email/index.ts).
 *
 * Flow:
 *   createRsvpSend  — OWNER/ADMIN. In ONE transaction: lock the Match row (FOR UPDATE +
 *                     chat / organization FOR SHARE, as website answers do), then the
 *                     organization's quota lock (pg_advisory_xact_lock "rsvp-quota:<org>");
 *                     re-check idempotency (requestKey), the match (Telegram / canceled /
 *                     completed / closed / deadline), roster, answers, overrides and
 *                     suppression; reserve up to the REMAINING day / month allowance;
 *                     write the RsvpSend + one RsvpInvitation per roster player (QUEUED for
 *                     those reserved, SKIPPED with a reason for the rest).
 *   processRsvpQueue — worker / scheduler continuation, bounded per call. Recovers stale
 *                     SENDING rows (→ UNCERTAIN), claims QUEUED rows one at a time with
 *                     FOR UPDATE SKIP LOCKED (concurrent workers never claim the same row),
 *                     re-checks the row, prepares a NEW emailed personal link and an
 *                     unsubscribe token (hash-only), sends with a provider idempotency key
 *                     and records SENT / FAILED / UNCERTAIN.
 *   retryFailedInvitations — OWNER/ADMIN: FAILED rows (definitely not accepted) of a send
 *                     go back to QUEUED, re-reserved under the same locks; never UNCERTAIN.
 *
 * Quota: QUEUED + SENDING (reserved, counted live from invitations) and SENT + UNCERTAIN
 * (consumed, in the durable RsvpEmailUsage ledger — survives match / player deletion)
 * count by the UTC day / month of the reservation; FAILED and SKIPPED don't. A row moves
 * from reserved to consumed in one transaction. Every reservation runs under the
 * organization's advisory lock (READ COMMITTED; usage is read in one statement after
 * taking the lock, so concurrent sends serialize and can't exceed either limit).
 * Releasing (→ FAILED / SKIPPED) only lowers usage and needs no lock. UNCERTAIN is never
 * released.
 * Addresses and tokens are never logged; stored errors are sanitized categories.
 */
export const RSVP_STALE_SENDING_MS = 10 * 60_000;
export const RSVP_MAX_ATTEMPTS = 3;
export const RSVP_BATCH_LIMIT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const MANAGERS = ["OWNER", "ADMIN"] as const;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export class RsvpDeliveryDisabledError extends Error {
  constructor() {
    super("RSVP email delivery is not available in this environment (test outbox only).");
    this.name = "RsvpDeliveryDisabledError";
  }
}

type Env = Record<string, string | undefined>;
export { rsvpDeliveryMode, rsvpDeliveryAllowedFor, isLocalTestDatabaseUrl } from "@/lib/rsvpDeliveryMode";

let testTransportOverride: EmailTransport | null = null;
/** Tests only: route RSVP delivery through a fake transport (refused outside NODE_ENV=test). */
export function setRsvpTransportForTests(t: EmailTransport | null, env: Env = process.env): void {
  if (env.NODE_ENV !== "test") throw new RsvpDeliveryDisabledError();
  testTransportOverride = t;
}
/**
 * The RSVP transport for the current mode: the in-memory test outbox ("test-outbox"), a
 * dedicated Resend transport ("live" — its own instance; account email keeps its own path),
 * or RsvpDeliveryDisabledError. The Resend transport serializes the idempotency key and the
 * two allowlisted List-Unsubscribe headers and refuses any other header; its errors carry
 * only a category and HTTP status (sanitizeSendError stores no message).
 */
export function rsvpTransport(env: Env = process.env, fetchImpl?: typeof fetch): EmailTransport {
  const mode = rsvpDeliveryMode(env);
  if (mode === "test-outbox") return (env.NODE_ENV === "test" ? testTransportOverride : null) ?? testOutbox;
  if (mode === "live") return createRsvpResendTransport(env, fetchImpl);
  throw new RsvpDeliveryDisabledError();
}

export type SendRefusal = PreviewRefusal | "DELIVERY_DISABLED" | "INVALID_REQUEST" | "REQUEST_KEY_CONFLICT" | "ALREADY_SENT" | "NOTHING_TO_RESEND" | "NOTHING_TO_SEND" | "PLAN_LIMIT" | "ROSTER_CHANGED";
export type SendCounts = { queued: number; skipped: number; byReason: Record<string, number> };
export type CreateSendResult = { ok: true; sendId: string; round: number; duplicate: boolean; counts: SendCounts } | { ok: false; code: SendRefusal; willSend?: number };

// Raw SQL timestamps are passed as UTC ISO text cast to "timestamp" (the columns are
// timestamp(3) without time zone, holding UTC), never as Date parameters — those would be
// shifted by the session's TimeZone setting.
const quotaLock = (tx: Prisma.TransactionClient, organizationId: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"rsvp-quota:" + organizationId}))`;
/** Live pilot only: one cross-organization daily cap, locked AFTER the organization lock (fixed order). */
const pilotLock = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"rsvp-quota:pilot-all"}))`;
/** Remaining capacity: the organization's day / month allowance and, when live, the pilot-wide daily cap. */
async function capacityFor(tx: Prisma.TransactionClient, organizationId: string, now: Date): Promise<number> {
  const allowance = await rsvpAllowance(organizationId, now, tx);
  const own = Math.min(allowance.day.remaining, allowance.month.remaining);
  if (rsvpDeliveryMode() !== "live") return own;
  await pilotLock(tx);
  return Math.min(own, await pilotGlobalRemaining(now, tx));
}
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function countsOf(sendId: string): Promise<SendCounts> {
  const rows = await prisma.rsvpInvitation.findMany({ where: { sendId }, select: { status: true, skipReason: true } });
  const byReason: Record<string, number> = {};
  for (const r of rows) if (r.status === "SKIPPED") byReason[r.skipReason ?? "UNKNOWN"] = (byReason[r.skipReason ?? "UNKNOWN"] ?? 0) + 1;
  return { queued: rows.filter((r) => r.status !== "SKIPPED").length, skipped: rows.filter((r) => r.status === "SKIPPED").length, byReason };
}

async function existingSend(requestKey: string, organizationId: string, matchId: string): Promise<CreateSendResult | null> {
  const s = await prisma.rsvpSend.findUnique({ where: { requestKey }, select: { id: true, round: true, organizationId: true, matchId: true } });
  if (!s) return null;
  if (s.organizationId !== organizationId || s.matchId !== matchId) return { ok: false, code: "REQUEST_KEY_CONFLICT" };
  return { ok: true, sendId: s.id, round: s.round, duplicate: true, counts: await countsOf(s.id) };
}

/** OWNER/ADMIN: queue an RSVP send for one match (idempotent per requestKey). Sends nothing itself. */
export async function createRsvpSend(
  context: TenantContext,
  matchId: string,
  input: { kind: RsvpSendKind; requestKey: string; /** P5: the recipient count the organizer reviewed */ expectedCount?: number; /** P5: the organizer confirmed they may contact them */ attested?: boolean },
  now: Date = new Date()
): Promise<CreateSendResult> {
  requireRole(context, [...MANAGERS]);
  if (!rsvpDeliveryAllowedFor(context.organization.id)) return { ok: false, code: "DELIVERY_DISABLED" };
  if (!REQUEST_KEY.test(input.requestKey) || (input.kind !== "INITIAL" && input.kind !== "RESEND")) return { ok: false, code: "INVALID_REQUEST" };
  const organizationId = context.organization.id;
  const groupId = context.activeGroup.id;
  const dup = await existingSend(input.requestKey, organizationId, matchId);
  if (dup) return dup;

  try {
    const created = await prisma.$transaction(
      async (tx): Promise<CreateSendResult | { ok: true; sendId: string; round: number }> => {
        const match = await tx.match.findFirst({ where: { id: matchId, groupId }, select: MATCH_SELECT });
        if (!match) return { ok: false, code: "NOT_FOUND" };
        await lockMatchForAnswer(tx, match.id); // match row FOR UPDATE (+ chat / org FOR SHARE): one send at a time per match
        await quotaLock(tx, organizationId); // then the organization's quota scope — always in this order
        const again = await tx.rsvpSend.findUnique({ where: { requestKey: input.requestKey }, select: { id: true } });
        if (again) return { ok: true, sendId: again.id, round: -1 };
        const fresh = await tx.match.findFirstOrThrow({ where: { id: match.id }, select: MATCH_SELECT });
        const refusal = await matchRefusal(groupId, fresh, now, tx);
        if (refusal) return { ok: false, code: refusal };
        const previous = await tx.rsvpSend.aggregate({ where: { matchId: match.id }, _max: { round: true } });
        if (input.kind === "INITIAL" && previous._max.round !== null) return { ok: false, code: "ALREADY_SENT" };
        if (input.kind === "RESEND" && previous._max.round === null) return { ok: false, code: "NOTHING_TO_RESEND" };

        const { rows } = await classifyRoster(organizationId, fresh, await capacityFor(tx, organizationId, now), tx);
        const willSend = rows.filter((r) => r.status === "WILL_SEND");
        if (willSend.length === 0) return { ok: false, code: rows.some((r) => r.status === "OVER_LIMIT") ? "PLAN_LIMIT" : input.kind === "RESEND" ? "NOTHING_TO_RESEND" : "NOTHING_TO_SEND" };
        // The organizer confirmed a count from the preview; anything changed since (roster,
        // answers, contacts, unsubscribes, allowance) → refuse and let them review again.
        if (input.expectedCount !== undefined && willSend.length !== input.expectedCount) return { ok: false, code: "ROSTER_CHANGED", willSend: willSend.length };

        const round = (previous._max.round ?? 0) + 1;
        const send = await tx.rsvpSend.create({ data: { organizationId, groupId, matchId: match.id, kind: input.kind, round, requestKey: input.requestKey, createdByUserId: context.user.id, createdAt: now, attestedAt: input.attested ? now : null, confirmedCount: input.expectedCount ?? null }, select: { id: true } });
        await tx.rsvpInvitation.createMany({
          data: rows.map((r) => {
            const sendable = r.status === "WILL_SEND" && (r.recipient.kind === "CONTACT" || r.recipient.kind === "ACCOUNT");
            return {
              sendId: send.id,
              organizationId,
              groupId,
              matchId: match.id,
              playerId: r.playerId,
              round,
              email: sendable && (r.recipient.kind === "CONTACT" || r.recipient.kind === "ACCOUNT") ? r.recipient.email : null,
              recipientType: r.recipient.kind === "CONTACT" || r.recipient.kind === "UNCONFIRMED_CONTACT" ? r.recipient.contactType : r.recipient.kind === "ACCOUNT" ? "ACCOUNT" : null,
              status: sendable ? "QUEUED" : "SKIPPED",
              skipReason: sendable ? null : r.status === "OVER_LIMIT" ? "LIMIT" : r.status,
              reservedAt: sendable ? now : null,
              createdAt: now,
            };
          }),
        });
        return { ok: true, sendId: send.id, round };
      },
      { timeout: 30_000 }
    );
    if (!created.ok) return created;
    if ("counts" in created) return created;
    if (created.round === -1) return (await existingSend(input.requestKey, organizationId, matchId))!;
    return { ok: true, sendId: created.sendId, round: created.round, duplicate: false, counts: await countsOf(created.sendId) };
  } catch (e) {
    if (isUnique(e)) {
      const dupe = await existingSend(input.requestKey, organizationId, matchId);
      if (dupe) return dupe;
    }
    throw e;
  }
}

/**
 * M13B P8A.1 — how an RSVP hand-off error is treated (Resend API errors reference,
 * idempotency-keys and rate-limit docs). Conservative: anything that MAY have been accepted
 * is UNCERTAIN (counted, never retried automatically); only a definite refusal is FAILED
 * (released). `stop` ends the current worker run so a broken configuration or a struggling
 * provider isn't hammered; `backoffSeconds` pushes the global pacer for every worker.
 *   429 rate_limit_exceeded / daily / monthly quota → RATE_LIMITED: back to QUEUED (still
 *       reserved) with the SAME idempotency key, not before Retry-After (default 60 s).
 *       If the provider had in fact processed it, the replay gets the original response
 *       or a 409 (→ UNCERTAIN) — never a second email.
 *   409 concurrent / invalid idempotent request / resource_locked → UNCERTAIN.
 *   401 / 403 / 404 / 405 → FAILED (nothing sent: key, permission or endpoint) and stop.
 *   other 4xx (400 validation, 422 …) → FAILED (the request was refused).
 *   5xx (500 application_error, 503 unavailable) → UNCERTAIN, stop, back off 60 s.
 *   network error / timeout / connection reset → UNCERTAIN, stop, back off 30 s.
 *   configuration error before hand-off → FAILED and stop (nothing reached the provider).
 *   anything unexpected → UNCERTAIN.
 */
export type ProviderOutcome = { outcome: "FAILED" | "UNCERTAIN" | "RATE_LIMITED"; stop: boolean; backoffSeconds: number | null };
export const RSVP_RATE_LIMIT_DEFAULT_SECONDS = 60;
export function classifyRsvpSendError(e: unknown): ProviderOutcome {
  if (e instanceof EmailConfigError) return { outcome: "FAILED", stop: true, backoffSeconds: null };
  if (e instanceof EmailDeliveryError) {
    if (e.reason !== "http" || e.status === null) return { outcome: "UNCERTAIN", stop: true, backoffSeconds: 30 };
    const s = e.status;
    if (s === 429) return { outcome: "RATE_LIMITED", stop: true, backoffSeconds: e.retryAfterSeconds ?? RSVP_RATE_LIMIT_DEFAULT_SECONDS };
    if (s === 409) return { outcome: "UNCERTAIN", stop: false, backoffSeconds: null };
    if (s === 401 || s === 403 || s === 404 || s === 405) return { outcome: "FAILED", stop: true, backoffSeconds: null };
    if (s >= 400 && s < 500) return { outcome: "FAILED", stop: false, backoffSeconds: null };
    if (s >= 500) return { outcome: "UNCERTAIN", stop: true, backoffSeconds: 60 };
    return { outcome: "UNCERTAIN", stop: true, backoffSeconds: 30 };
  }
  return { outcome: "UNCERTAIN", stop: false, backoffSeconds: null };
}

/**
 * M13B P8A.1 — global pacing of LIVE hand-offs (all workers, all instances): each hand-off
 * atomically takes the next slot of the single RsvpDeliveryPacer row, at least
 * RSVP_LIVE_MIN_INTERVAL_MS apart (≤ 4 per second; Resend's default is 10 per second per
 * team, shared with account email). Returns how long to wait for the slot.
 */
export const RSVP_LIVE_MIN_INTERVAL_MS = 250;
async function takePacerSlot(): Promise<number> {
  const at = new Date().toISOString();
  const [row] = await prisma.$queryRaw<Array<{ slot: Date }>>`
    INSERT INTO "RsvpDeliveryPacer" ("id", "nextSlotAt") VALUES (1, ${at}::timestamp + make_interval(secs => ${RSVP_LIVE_MIN_INTERVAL_MS / 1000}))
    ON CONFLICT ("id") DO UPDATE SET "nextSlotAt" = GREATEST("RsvpDeliveryPacer"."nextSlotAt", ${at}::timestamp) + make_interval(secs => ${RSVP_LIVE_MIN_INTERVAL_MS / 1000})
    RETURNING ("nextSlotAt" - make_interval(secs => ${RSVP_LIVE_MIN_INTERVAL_MS / 1000})) AS slot`;
  return Math.max(0, row.slot.getTime() - Date.now()); // timestamp columns hold UTC; Prisma reads them as UTC
}
/** Provider asked us to slow down (429 Retry-After) or is failing: no worker hands off before then. */
async function pushPacer(seconds: number): Promise<void> {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await prisma.$executeRaw`INSERT INTO "RsvpDeliveryPacer" ("id", "nextSlotAt") VALUES (1, ${until}::timestamp)
    ON CONFLICT ("id") DO UPDATE SET "nextSlotAt" = GREATEST("RsvpDeliveryPacer"."nextSlotAt", ${until}::timestamp)`;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sanitized, address-free error category for storage. */
export function sanitizeSendError(e: unknown): string {
  if (e instanceof EmailDeliveryError) return e.status === 429 ? "RATE_LIMITED" : `${e.reason.toUpperCase()}${e.status ? `_${e.status}` : ""}`;
  if (e instanceof EmailConfigError) return "CONFIG";
  if (e instanceof RsvpDeliveryDisabledError) return "DELIVERY_DISABLED";
  return "UNEXPECTED";
}

/**
 * Rows stuck in SENDING (crash / timeout mid-send) become UNCERTAIN — never retried
 * automatically — and are moved to the consumed ledger in the SAME statement.
 */
export async function recoverStaleSending(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RSVP_STALE_SENDING_MS);
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    WITH moved AS (
      UPDATE "RsvpInvitation" SET "status" = 'UNCERTAIN', "lastError" = 'STALE_CLAIM', "updatedAt" = ${now.toISOString()}::timestamp
      WHERE "status" = 'SENDING' AND "claimedAt" < ${cutoff.toISOString()}::timestamp
      RETURNING "organizationId", "reservedAt"
    ), counted AS (
      INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed")
      SELECT "organizationId", "reservedAt"::date, count(*)::int FROM moved WHERE "reservedAt" IS NOT NULL GROUP BY 1, 2
      ON CONFLICT ("organizationId", "day") DO UPDATE SET "consumed" = "RsvpEmailUsage"."consumed" + EXCLUDED."consumed"
      RETURNING 1
    )
    SELECT count(*)::bigint AS n FROM moved`;
  return Number(rows[0]?.n ?? 0);
}

/** One more consumed email for the organization on the UTC day of its reservation. */
const consume = (tx: Prisma.TransactionClient, organizationId: string, reservedAt: Date) =>
  tx.$executeRaw`INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed") VALUES (${organizationId}, ${reservedAt.toISOString().slice(0, 10)}::date, 1)
    ON CONFLICT ("organizationId", "day") DO UPDATE SET "consumed" = "RsvpEmailUsage"."consumed" + 1`;

/**
 * Record a delivery outcome for a claimed row, under its row lock. SENT / UNCERTAIN move
 * the reservation to the consumed ledger in the same transaction. If the row is gone
 * (its match was deleted mid-send) a hand-off that may have reached the provider is still
 * counted. A row already recovered as UNCERTAIN (stale) is not counted again.
 */
async function settle(id: string, organizationId: string, reservedAt: Date | null, outcome: "SENT" | "UNCERTAIN" | "FAILED", data: Prisma.RsvpInvitationUpdateManyMutationInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "RsvpInvitation" WHERE "id" = ${id} FOR UPDATE`;
    const counts = outcome !== "FAILED" && reservedAt;
    if (!row) {
      if (counts) await consume(tx, organizationId, reservedAt);
      return;
    }
    if (row.status === "SENDING") {
      await tx.rsvpInvitation.updateMany({ where: { id }, data: { status: outcome, ...data } });
      if (counts) await consume(tx, organizationId, reservedAt);
    } else if (row.status === "UNCERTAIN" && outcome === "SENT") {
      await tx.rsvpInvitation.updateMany({ where: { id }, data: { status: "SENT", ...data } }); // already counted
    }
  });
}

type Claimed = { id: string; attempts: number };

async function claimNext(now: Date, sendId: string | null, organizations: string[] | null): Promise<Claimed | null> {
  const at = now.toISOString();
  const bySend = sendId ? Prisma.sql`AND "sendId" = ${sendId}` : Prisma.empty;
  // Live pilot: only allowlisted organizations' rows are ever claimed (others stay QUEUED).
  const byOrg = organizations ? Prisma.sql`AND "organizationId" IN (${Prisma.join(organizations)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<Claimed[]>`UPDATE "RsvpInvitation" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "claimedAt" = ${at}::timestamp, "updatedAt" = ${at}::timestamp
    WHERE "id" = (SELECT "id" FROM "RsvpInvitation" WHERE "status" = 'QUEUED' AND ("notBefore" IS NULL OR "notBefore" <= ${at}::timestamp) ${bySend} ${byOrg} ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING "id", "attempts"`;
  return rows[0] ?? null;
}

const skip = (id: string, reason: string) => prisma.rsvpInvitation.updateMany({ where: { id, status: "SENDING" }, data: { status: "SKIPPED", skipReason: reason, claimedAt: null } });

/** Deliver ONE claimed (SENDING) invitation. */
type Delivered = "SENT" | "FAILED" | "UNCERTAIN" | "SKIPPED" | "RATE_LIMITED";
type DeliveryResult = { kind: Delivered; stop: boolean; backoffSeconds: number | null };
const done = (kind: Delivered): DeliveryResult => ({ kind, stop: false, backoffSeconds: null });

async function deliverOne(c: Claimed, transport: EmailTransport, now: Date): Promise<DeliveryResult> {
  const inv = await prisma.rsvpInvitation.findUnique({
    where: { id: c.id },
    select: {
      id: true,
      organizationId: true,
      groupId: true,
      matchId: true,
      playerId: true,
      email: true,
      recipientType: true,
      reservedAt: true,
      organization: { select: { name: true } },
      group: { select: { name: true, timezone: true } },
      player: { select: { firstName: true, lastName: true, contactEmail: true, contactEmailType: true, contactAuthorizedAt: true, user: { select: { email: true, emailVerifiedAt: true } } } },
      match: { select: { ...MATCH_SELECT, locationName: true, venue: { select: { name: true } }, community: { select: { name: true } } } },
    },
  });
  if (!inv) return done("SKIPPED"); // removed with its match after the claim
  if (!inv.playerId || !inv.player || !inv.email || !inv.recipientType) {
    await skip(inv.id, "PLAYER_REMOVED");
    return done("SKIPPED");
  }
  // Re-check at send time: the match may have closed / become a Telegram match, the
  // address may have been suppressed, the player may have answered meanwhile.
  const refusal = await matchRefusal(inv.groupId, inv.match, now);
  if (refusal) {
    await skip(inv.id, refusal);
    return done("SKIPPED");
  }
  // P6: the destination must still be the player's current, confirmed recipient — a contact
  // removed, changed or unconfirmed after queuing is never emailed at its old address.
  const current = resolveRecipient(inv.player);
  if ((current.kind !== "CONTACT" && current.kind !== "ACCOUNT") || current.email !== normalizeEmail(inv.email)) {
    await skip(inv.id, "CONTACT_CHANGED");
    return done("SKIPPED");
  }
  if ((await suppressedFor(inv.organizationId, [inv.email])).size > 0) {
    await skip(inv.id, "SUPPRESSED");
    return done("SKIPPED");
  }
  const answered = await prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId: inv.matchId, playerId: inv.playerId } }, select: { participantStatus: true, overrideStatus: true } });
  if (answered?.overrideStatus || answered?.participantStatus) {
    await skip(inv.id, answered.overrideStatus ? "ORGANIZER_OVERRIDE" : "ALREADY_ANSWERED");
    return done("SKIPPED");
  }

  // Prepare this attempt's capabilities (hash-only). Existing links are NOT touched here:
  // older EMAIL links are revoked only after this email is accepted; MANUAL links never.
  const answerToken = generateToken();
  const unsubscribeToken = generateToken(); // the /unsubscribe page link (URL fragment)
  const oneClickToken = generateToken(); // RFC 8058 header URL (query string) — one-click only
  const idempotencyKey = `rsvp:${inv.id}:${c.attempts}`;
  const prepared = await prisma.$transaction(async (tx) => {
    const link = await tx.personalAttendanceLink.create({
      data: { organizationId: inv.organizationId, groupId: inv.groupId, matchId: inv.matchId, playerId: inv.playerId!, tokenHash: hashToken(answerToken), channel: "EMAIL", createdAt: now },
      select: { id: true },
    });
    const unsub = await tx.emailUnsubscribeToken.create({
      data: { organizationId: inv.organizationId, email: inv.email!, tokenHash: hashToken(unsubscribeToken), createdAt: now, expiresAt: new Date(now.getTime() + UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_MS) },
      select: { id: true },
    });
    await tx.emailUnsubscribeToken.create({
      data: { organizationId: inv.organizationId, email: inv.email!, tokenHash: hashToken(oneClickToken), oneClickOnly: true, createdAt: now, expiresAt: new Date(now.getTime() + UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_MS) },
    });
    await tx.rsvpInvitation.update({ where: { id: inv.id }, data: { linkId: link.id, unsubscribeTokenId: unsub.id, idempotencyKey } });
    return { linkId: link.id };
  });

  try {
    // Built inside the try: a configuration error here (APP_BASE_URL / EMAIL_FROM) means
    // nothing reached the provider, so it is FAILED (released), not UNCERTAIN.
    const m = inv.match;
    const day = m.date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
    const time = formatStartTime(m.startTime);
    const links = { page: unsubscribeLinks(unsubscribeToken).page, oneClick: unsubscribeLinks(oneClickToken).oneClick };
    const message = buildRsvpInvitationEmail({
      to: inv.email,
      recipientType: inv.recipientType,
      playerName: `${inv.player.firstName} ${inv.player.lastName}`.trim(),
      organizationName: inv.organization.name,
      title: m.community?.name ?? inv.group.name,
      when: `${day}${time ? ` at ${time}` : ""}`,
      venue: m.venue?.name ?? m.locationName ?? null,
      deadline: m.attendanceDeadlineAt ? formatDeadline(m.attendanceDeadlineAt.toISOString(), inv.group.timezone, now) : null,
      // The token stays in the fragment (never sent to a server); ?c= only pre-selects a choice.
      answerUrls: {
        open: appUrl(`${PERSONAL_ATTENDANCE_PATH}#${answerToken}`),
        yes: appUrl(`${PERSONAL_ATTENDANCE_PATH}?c=yes#${answerToken}`),
        maybe: appUrl(`${PERSONAL_ATTENDANCE_PATH}?c=maybe#${answerToken}`),
        no: appUrl(`${PERSONAL_ATTENDANCE_PATH}?c=no#${answerToken}`),
      },
      unsubscribeUrl: links.page,
    });

    const result = await transport.send({ ...message, from: getEmailFrom(), idempotencyKey, headers: oneClickUnsubscribeHeaders(links.oneClick) });
    await settle(inv.id, inv.organizationId, inv.reservedAt, "SENT", { sentAt: new Date(), providerMessageId: result.providerMessageId, lastError: null });
    await prisma.personalAttendanceLink.updateMany({
      where: { matchId: inv.matchId, playerId: inv.playerId, channel: "EMAIL", revokedAt: null, id: { not: prepared.linkId } },
      data: { revokedAt: new Date(), replacedAt: new Date() },
    });
    return done("SENT");
  } catch (e) {
    const verdict = classifyRsvpSendError(e);
    const lastError = sanitizeSendError(e);
    if (verdict.outcome === "RATE_LIMITED") {
      // Not accepted (documented 429) — but we don't rely on that: back to QUEUED, still
      // reserved, same idempotency key next time (attempts restored), not before Retry-After.
      const notBefore = new Date(now.getTime() + (verdict.backoffSeconds ?? RSVP_RATE_LIMIT_DEFAULT_SECONDS) * 1000);
      await prisma.rsvpInvitation.updateMany({ where: { id: inv.id, status: "SENDING" }, data: { status: "QUEUED", attempts: { decrement: 1 }, claimedAt: null, notBefore, lastError } });
      return { kind: "RATE_LIMITED", stop: true, backoffSeconds: verdict.backoffSeconds };
    }
    if (verdict.outcome === "FAILED") {
      // Definitely not accepted: release the reservation; the unsent link is revoked.
      await settle(inv.id, inv.organizationId, inv.reservedAt, "FAILED", { failedAt: new Date(), lastError });
      await prisma.personalAttendanceLink.updateMany({ where: { id: prepared.linkId, revokedAt: null }, data: { revokedAt: new Date() } });
      return { kind: "FAILED", stop: verdict.stop, backoffSeconds: verdict.backoffSeconds };
    }
    // Maybe delivered: keep it counted and keep its link working; never retried automatically.
    await settle(inv.id, inv.organizationId, inv.reservedAt, "UNCERTAIN", { lastError });
    return { kind: "UNCERTAIN", stop: verdict.stop, backoffSeconds: verdict.backoffSeconds };
  }
}

export type QueueRun = {
  recovered: number;
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
  rateLimited: number;
  errors: number;
  remaining: number;
  stoppedForTime: boolean;
  /** P8A.1: the run stopped early because the provider rate-limited, failed or was misconfigured. */
  stoppedForProvider: boolean;
};

/**
 * Worker / scheduler continuation: recover stale rows, then deliver QUEUED invitations
 * one claim at a time until `limit` rows or the `budgetMs` time budget is used (a new
 * claim is never started after the budget). An unexpected error on one row is counted
 * and the loop continues; that row stays SENDING and is later recovered as UNCERTAIN
 * (counted, never resent) — the conservative outcome.
 * P8A.1 — while LIVE: every hand-off waits for its global pacer slot (a slot beyond the
 * budget ends the run instead); the delivery mode and allowlist are re-read before each
 * claim (a disabled pilot hands off nothing more); a rate limit, provider failure or
 * configuration refusal ends the run and backs off every worker.
 */
export async function processRsvpQueue(opts: { limit?: number; sendId?: string; now?: Date; budgetMs?: number } = {}): Promise<QueueRun> {
  const transport = rsvpTransport(); // throws (before claiming anything) when delivery is disabled
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 25_000;
  const run: QueueRun = { recovered: await recoverStaleSending(now), sent: 0, failed: 0, uncertain: 0, skipped: 0, rateLimited: 0, errors: 0, remaining: 0, stoppedForTime: false, stoppedForProvider: false };
  let organizations: string[] | null = null;
  for (let i = 0; i < (opts.limit ?? RSVP_BATCH_LIMIT); i++) {
    if (Date.now() - started >= budget) {
      run.stoppedForTime = true;
      break;
    }
    const mode = rsvpDeliveryMode();
    if (mode === "disabled") break; // the pilot was switched off mid-run: no further hand-offs
    organizations = mode === "live" ? [...pilotOrganizations()!] : null;
    if (mode === "live") {
      const wait = await takePacerSlot();
      if (Date.now() - started + wait >= budget) {
        run.stoppedForTime = true;
        break;
      }
      if (wait > 0) await sleep(wait);
    }
    const claimed = await claimNext(now, opts.sendId ?? null, organizations);
    if (!claimed) break;
    try {
      const result = await deliverOne(claimed, transport, now);
      if (result.kind === "SENT") run.sent++;
      else if (result.kind === "FAILED") run.failed++;
      else if (result.kind === "UNCERTAIN") run.uncertain++;
      else if (result.kind === "RATE_LIMITED") run.rateLimited++;
      else run.skipped++;
      if (result.backoffSeconds && mode === "live") await pushPacer(result.backoffSeconds);
      if (result.stop) {
        run.stoppedForProvider = true;
        break;
      }
    } catch {
      run.errors++;
    }
  }
  run.remaining = await prisma.rsvpInvitation.count({ where: { status: "QUEUED", ...(opts.sendId ? { sendId: opts.sendId } : {}), ...(organizations ? { organizationId: { in: organizations } } : {}) } });
  return run;
}

/**
 * OWNER/ADMIN: re-queue FAILED invitations of one send (definitely not accepted before).
 * Each is re-checked and re-reserved under the match and quota locks; rows over the
 * attempt limit, no longer eligible, or beyond the remaining allowance stay FAILED.
 * UNCERTAIN rows are never retried.
 */
export async function retryFailedInvitations(context: TenantContext, sendId: string, now: Date = new Date()): Promise<{ ok: true; requeued: number; left: number } | { ok: false; code: "NOT_FOUND" | SendRefusal }> {
  requireRole(context, [...MANAGERS]);
  if (!rsvpDeliveryAllowedFor(context.organization.id)) return { ok: false, code: "DELIVERY_DISABLED" };
  const organizationId = context.organization.id;
  return prisma.$transaction(
    async (tx) => {
      const send = await tx.rsvpSend.findFirst({ where: { id: sendId, organizationId, groupId: context.activeGroup.id }, select: { id: true, matchId: true } });
      if (!send) return { ok: false as const, code: "NOT_FOUND" as const };
      await lockMatchForAnswer(tx, send.matchId);
      await quotaLock(tx, organizationId);
      const match = await tx.match.findFirstOrThrow({ where: { id: send.matchId }, select: MATCH_SELECT });
      const refusal = await matchRefusal(match.groupId, match, now, tx);
      if (refusal) return { ok: false as const, code: refusal };
      const failed = await tx.rsvpInvitation.findMany({ where: { sendId, status: "FAILED", attempts: { lt: RSVP_MAX_ATTEMPTS } }, select: { id: true, playerId: true } });
      // Eligibility without a capacity cut (others of this round may already be sent), then
      // re-reserve only as many as the remaining day / month allowance allows.
      const { rows } = await classifyRoster(organizationId, match, Number.POSITIVE_INFINITY, tx);
      const eligible = new Set(rows.filter((r) => r.status === "WILL_SEND").map((r) => r.playerId));
      const capacity = await capacityFor(tx, organizationId, now);
      const toRequeue = failed.filter((f) => f.playerId && eligible.has(f.playerId)).slice(0, capacity).map((f) => f.id);
      if (toRequeue.length) await tx.rsvpInvitation.updateMany({ where: { id: { in: toRequeue }, status: "FAILED" }, data: { status: "QUEUED", reservedAt: now, failedAt: null } });
      return { ok: true as const, requeued: toRequeue.length, left: failed.length - toRequeue.length };
    },
    { timeout: 30_000 }
  );
}
