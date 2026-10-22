import { Prisma, type RsvpSendKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { generateToken, hashToken } from "@/lib/secureToken";
import { lockMatchForAnswer } from "@/lib/attendanceClosure";
import { personalLinkPath } from "@/lib/personalAttendance";
import { suppressedFor, unsubscribeLinks, oneClickUnsubscribeHeaders, UNSUBSCRIBE_TOKEN_TTL_DAYS } from "@/lib/emailSuppression";
import { classifyRoster, matchRefusal, rsvpAllowance, MATCH_SELECT, type PreviewRefusal } from "@/lib/rsvpPreview";
import { appUrl, getEmailFrom, EmailConfigError } from "@/lib/email/config";
import { EmailDeliveryError, testOutbox, type EmailTransport } from "@/lib/email/transport";
import { buildRsvpInvitationEmail } from "@/lib/email/templates";
import { classifySendError } from "@/lib/trialLifecycle";
import { formatStartTime } from "@/lib/messaging/content";
import { formatDeadline } from "@/lib/deadlineFormat";

/**
 * M13B P4 — the RSVP email SENDING ENGINE (no HTTP route; not callable from the UI).
 *
 * DELIVERY IS TEST-ONLY IN P4, enforced here on the server: `rsvpTransport()` returns the
 * in-memory test outbox and only under NODE_ENV=test; everywhere else it throws
 * RsvpDeliveryDisabledError BEFORE anything is queued or claimed. No code path in this
 * module reaches the Resend transport, whatever the environment flags say.
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
    super("RSVP email delivery is not available in this build (M13B P4: test outbox only).");
    this.name = "RsvpDeliveryDisabledError";
  }
}

let testTransportOverride: EmailTransport | null = null;
/** Tests only: route RSVP delivery through a fake transport (refused outside NODE_ENV=test). */
export function setRsvpTransportForTests(t: EmailTransport | null, env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "test") throw new RsvpDeliveryDisabledError();
  testTransportOverride = t;
}
/** The ONLY RSVP transport in P4: the in-memory test outbox, under NODE_ENV=test only. */
export function rsvpTransport(env: Record<string, string | undefined> = process.env): EmailTransport {
  if (env.NODE_ENV !== "test") throw new RsvpDeliveryDisabledError();
  return testTransportOverride ?? testOutbox;
}

export type SendRefusal = PreviewRefusal | "DELIVERY_DISABLED" | "INVALID_REQUEST" | "REQUEST_KEY_CONFLICT" | "ALREADY_SENT" | "NOTHING_TO_RESEND" | "NOTHING_TO_SEND" | "PLAN_LIMIT";
export type SendCounts = { queued: number; skipped: number; byReason: Record<string, number> };
export type CreateSendResult = { ok: true; sendId: string; round: number; duplicate: boolean; counts: SendCounts } | { ok: false; code: SendRefusal };

// Raw SQL timestamps are passed as UTC ISO text cast to "timestamp" (the columns are
// timestamp(3) without time zone, holding UTC), never as Date parameters — those would be
// shifted by the session's TimeZone setting.
const quotaLock = (tx: Prisma.TransactionClient, organizationId: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"rsvp-quota:" + organizationId}))`;
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
export async function createRsvpSend(context: TenantContext, matchId: string, input: { kind: RsvpSendKind; requestKey: string }, now: Date = new Date()): Promise<CreateSendResult> {
  requireRole(context, [...MANAGERS]);
  try {
    rsvpTransport();
  } catch {
    return { ok: false, code: "DELIVERY_DISABLED" };
  }
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

        const allowance = await rsvpAllowance(organizationId, now, tx);
        const { rows } = await classifyRoster(organizationId, fresh, Math.min(allowance.day.remaining, allowance.month.remaining), tx);
        const willSend = rows.filter((r) => r.status === "WILL_SEND");
        if (willSend.length === 0) return { ok: false, code: rows.some((r) => r.status === "OVER_LIMIT") ? "PLAN_LIMIT" : input.kind === "RESEND" ? "NOTHING_TO_RESEND" : "NOTHING_TO_SEND" };

        const round = (previous._max.round ?? 0) + 1;
        const send = await tx.rsvpSend.create({ data: { organizationId, groupId, matchId: match.id, kind: input.kind, round, requestKey: input.requestKey, createdByUserId: context.user.id, createdAt: now }, select: { id: true } });
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
              recipientType: r.recipient.kind === "CONTACT" ? r.recipient.contactType : r.recipient.kind === "ACCOUNT" ? "ACCOUNT" : null,
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

/** Sanitized, address-free error category for storage. */
export function sanitizeSendError(e: unknown): string {
  if (e instanceof EmailDeliveryError) return `${e.reason.toUpperCase()}${e.status ? `_${e.status}` : ""}`;
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

async function claimNext(now: Date, sendId: string | null): Promise<Claimed | null> {
  const rows = sendId
    ? await prisma.$queryRaw<Claimed[]>`UPDATE "RsvpInvitation" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "claimedAt" = ${now.toISOString()}::timestamp, "updatedAt" = ${now.toISOString()}::timestamp
        WHERE "id" = (SELECT "id" FROM "RsvpInvitation" WHERE "status" = 'QUEUED' AND "sendId" = ${sendId} ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING "id", "attempts"`
    : await prisma.$queryRaw<Claimed[]>`UPDATE "RsvpInvitation" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "claimedAt" = ${now.toISOString()}::timestamp, "updatedAt" = ${now.toISOString()}::timestamp
        WHERE "id" = (SELECT "id" FROM "RsvpInvitation" WHERE "status" = 'QUEUED' ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING "id", "attempts"`;
  return rows[0] ?? null;
}

const skip = (id: string, reason: string) => prisma.rsvpInvitation.updateMany({ where: { id, status: "SENDING" }, data: { status: "SKIPPED", skipReason: reason, claimedAt: null } });

/** Deliver ONE claimed (SENDING) invitation. */
async function deliverOne(c: Claimed, transport: EmailTransport, now: Date): Promise<"SENT" | "FAILED" | "UNCERTAIN" | "SKIPPED"> {
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
      player: { select: { firstName: true, lastName: true } },
      match: { select: { ...MATCH_SELECT, locationName: true, venue: { select: { name: true } }, community: { select: { name: true } } } },
    },
  });
  if (!inv) return "SKIPPED"; // removed with its match after the claim
  if (!inv.playerId || !inv.player || !inv.email || !inv.recipientType) {
    await skip(inv.id, "PLAYER_REMOVED");
    return "SKIPPED";
  }
  // Re-check at send time: the match may have closed / become a Telegram match, the
  // address may have been suppressed, the player may have answered meanwhile.
  const refusal = await matchRefusal(inv.groupId, inv.match, now);
  if (refusal) {
    await skip(inv.id, refusal);
    return "SKIPPED";
  }
  if ((await suppressedFor(inv.organizationId, [inv.email])).size > 0) {
    await skip(inv.id, "SUPPRESSED");
    return "SKIPPED";
  }
  const answered = await prisma.attendanceResponse.findUnique({ where: { matchId_playerId: { matchId: inv.matchId, playerId: inv.playerId } }, select: { participantStatus: true, overrideStatus: true } });
  if (answered?.overrideStatus || answered?.participantStatus) {
    await skip(inv.id, answered.overrideStatus ? "ORGANIZER_OVERRIDE" : "ALREADY_ANSWERED");
    return "SKIPPED";
  }

  // Prepare this attempt's capabilities (hash-only). Existing links are NOT touched here:
  // older EMAIL links are revoked only after this email is accepted; MANUAL links never.
  const answerToken = generateToken();
  const unsubscribeToken = generateToken();
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
    await tx.rsvpInvitation.update({ where: { id: inv.id }, data: { linkId: link.id, unsubscribeTokenId: unsub.id, idempotencyKey } });
    return { linkId: link.id };
  });

  try {
    // Built inside the try: a configuration error here (APP_BASE_URL / EMAIL_FROM) means
    // nothing reached the provider, so it is FAILED (released), not UNCERTAIN.
    const m = inv.match;
    const day = m.date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
    const time = formatStartTime(m.startTime);
    const links = unsubscribeLinks(unsubscribeToken);
    const message = buildRsvpInvitationEmail({
      to: inv.email,
      recipientType: inv.recipientType,
      playerName: `${inv.player.firstName} ${inv.player.lastName}`.trim(),
      organizationName: inv.organization.name,
      title: m.community?.name ?? inv.group.name,
      when: `on ${day}${time ? ` at ${time}` : ""}`,
      venue: m.venue?.name ?? m.locationName ?? null,
      deadline: m.attendanceDeadlineAt ? formatDeadline(m.attendanceDeadlineAt.toISOString(), inv.group.timezone, now) : null,
      answerUrl: appUrl(personalLinkPath(answerToken)),
      unsubscribeUrl: links.page,
    });

    const result = await transport.send({ ...message, from: getEmailFrom(), idempotencyKey, headers: oneClickUnsubscribeHeaders(links.oneClick) });
    await settle(inv.id, inv.organizationId, inv.reservedAt, "SENT", { sentAt: new Date(), providerMessageId: result.providerMessageId, lastError: null });
    await prisma.personalAttendanceLink.updateMany({
      where: { matchId: inv.matchId, playerId: inv.playerId, channel: "EMAIL", revokedAt: null, id: { not: prepared.linkId } },
      data: { revokedAt: new Date() },
    });
    return "SENT";
  } catch (e) {
    const outcome = classifySendError(e);
    const lastError = sanitizeSendError(e);
    if (outcome === "FAILED") {
      // Definitely not accepted: release the reservation; the unsent link is revoked.
      await settle(inv.id, inv.organizationId, inv.reservedAt, "FAILED", { failedAt: new Date(), lastError });
      await prisma.personalAttendanceLink.updateMany({ where: { id: prepared.linkId, revokedAt: null }, data: { revokedAt: new Date() } });
      return "FAILED";
    }
    // Maybe delivered: keep it counted and keep its link working; never retried automatically.
    await settle(inv.id, inv.organizationId, inv.reservedAt, "UNCERTAIN", { lastError });
    return "UNCERTAIN";
  }
}

export type QueueRun = { recovered: number; sent: number; failed: number; uncertain: number; skipped: number; errors: number; remaining: number; stoppedForTime: boolean };

/**
 * Worker / scheduler continuation: recover stale rows, then deliver QUEUED invitations
 * one claim at a time until `limit` rows or the `budgetMs` time budget is used (a new
 * claim is never started after the budget). An unexpected error on one row is counted
 * and the loop continues; that row stays SENDING and is later recovered as UNCERTAIN
 * (counted, never resent) — the conservative outcome.
 */
export async function processRsvpQueue(opts: { limit?: number; sendId?: string; now?: Date; budgetMs?: number } = {}): Promise<QueueRun> {
  const transport = rsvpTransport(); // throws (before claiming anything) outside the test environment
  const now = opts.now ?? new Date();
  const started = Date.now();
  const run: QueueRun = { recovered: await recoverStaleSending(now), sent: 0, failed: 0, uncertain: 0, skipped: 0, errors: 0, remaining: 0, stoppedForTime: false };
  for (let i = 0; i < (opts.limit ?? RSVP_BATCH_LIMIT); i++) {
    if (opts.budgetMs !== undefined && Date.now() - started >= opts.budgetMs) {
      run.stoppedForTime = true;
      break;
    }
    const claimed = await claimNext(now, opts.sendId ?? null);
    if (!claimed) break;
    try {
      const outcome = await deliverOne(claimed, transport, now);
      if (outcome === "SENT") run.sent++;
      else if (outcome === "FAILED") run.failed++;
      else if (outcome === "UNCERTAIN") run.uncertain++;
      else run.skipped++;
    } catch {
      run.errors++;
    }
  }
  run.remaining = await prisma.rsvpInvitation.count({ where: { status: "QUEUED", ...(opts.sendId ? { sendId: opts.sendId } : {}) } });
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
  try {
    rsvpTransport();
  } catch {
    return { ok: false, code: "DELIVERY_DISABLED" };
  }
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
      const allowance = await rsvpAllowance(organizationId, now, tx);
      // Eligibility without a capacity cut (others of this round may already be sent), then
      // re-reserve only as many as the remaining day / month allowance allows.
      const { rows } = await classifyRoster(organizationId, match, Number.POSITIVE_INFINITY, tx);
      const eligible = new Set(rows.filter((r) => r.status === "WILL_SEND").map((r) => r.playerId));
      const capacity = Math.min(allowance.day.remaining, allowance.month.remaining);
      const toRequeue = failed.filter((f) => f.playerId && eligible.has(f.playerId)).slice(0, capacity).map((f) => f.id);
      if (toRequeue.length) await tx.rsvpInvitation.updateMany({ where: { id: { in: toRequeue }, status: "FAILED" }, data: { status: "QUEUED", reservedAt: now, failedAt: null } });
      return { ok: true as const, requeued: toRequeue.length, left: failed.length - toRequeue.length };
    },
    { timeout: 30_000 }
  );
}
