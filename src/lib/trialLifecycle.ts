import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITLING_STATUSES } from "@/lib/billing/sync";
import { billingConfig } from "@/lib/billing/config";
import { organizationTimeZone, trialDateLabel, trialDaysLeft, trialStatus, upgradeHint } from "@/lib/entitlements";
import { EmailConfigError, EmailDeliveryError, sendTrialEmail } from "@/lib/email";

/**
 * M11.3 — the trial lifecycle job: reminder emails before a Pro trial ends, one
 * email when it has ended, and a TRIAL_EXPIRED audit event. It is NOT what ends
 * a trial: the Free plan applies at the exact instant trialEndsAt passes, on
 * every request (entitlements.effectivePlan), whether or not this job runs.
 *
 * Mode (TRIAL_LIFECYCLE): "off" (default — does nothing), "audit" (records
 * TRIAL_EXPIRED events only; never emails), "send" (also emails OWNERs).
 *
 * Who: FREE Organizations with a trial end only — LEGACY / COMP / PRO never have
 * one in this sense, and an Organization that converted to Stripe Pro or has an
 * entitling subscription is skipped (no "your trial ends" to a paying customer).
 *
 * Idempotency: one TrialNotice row per (Organization, stage, trialEndsAt, OWNER),
 * claimed by a unique insert before sending, so concurrent or repeated runs send
 * each email at most once. Outcomes:
 *   SENT      — Resend accepted it (2xx). Never sent again.
 *   FAILED    — Resend definitely did NOT accept it (4xx other than 409, or our
 *               own configuration error): retried on later runs up to MAX_ATTEMPTS.
 *   UNCERTAIN — no clear answer (timeout, network error, 5xx, 409, or a claim left
 *               SENDING by a crash): it may have gone out. Retried only inside
 *               Resend's idempotency window (UNCERTAIN_RETRY_WINDOW_MS after the
 *               first attempt), with the SAME Idempotency-Key and the SAME content
 *               (daysLeft is frozen on the row), so Resend delivers it at most once.
 *               After the window it is never sent again.
 * Audit mode writes no TrialNotice row at all: it neither marks an email as
 * delivered nor uses up a send opportunity.
 * A late run sends only the CURRENT stage (missed earlier reminders are not sent
 * in a burst). A trial extension (new trialEndsAt) starts a new series.
 * Dates are shown in the organization's timezone; the end instant is UTC.
 */
export type TrialLifecycleMode = "off" | "audit" | "send";
export type TrialStage = "D14" | "D7" | "D3" | "D1" | "EXPIRED";

const DAY_MS = 86_400_000;
export const REMINDER_DAYS = [1, 3, 7, 14] as const;
/** The expiry email goes out only within this window after the end (never months later). */
export const EXPIRED_NOTICE_WINDOW_MS = 7 * DAY_MS;
export const MAX_ATTEMPTS = 3;
/** A SENDING claim older than this was interrupted (crash/timeout): treated as UNCERTAIN. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Resend keeps idempotency keys for 24 h; uncertain sends are retried only well inside that. */
export const UNCERTAIN_RETRY_WINDOW_MS = 23 * 3_600_000;

/** How a send error is recorded: definitely-not-accepted vs. maybe-sent. */
export function classifySendError(e: unknown): "FAILED" | "UNCERTAIN" {
  if (e instanceof EmailConfigError) return "FAILED"; // nothing was handed to the provider
  if (e instanceof EmailDeliveryError && e.reason === "http" && e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 409) return "FAILED";
  return "UNCERTAIN"; // timeout, network, 5xx, 409 (same key in flight / reused), anything unexpected
}
/** TRIAL_EXPIRED events are recorded for trials that ended within this period (bounded scan). */
const AUDIT_LOOKBACK_MS = 400 * DAY_MS;
export const TRIAL_ACTOR = "system:trial-lifecycle";

export function trialLifecycleMode(env: Record<string, string | undefined> = process.env): TrialLifecycleMode {
  const v = env.TRIAL_LIFECYCLE?.trim().toLowerCase();
  return v === "send" ? "send" : v === "audit" ? "audit" : "off";
}

/** The email stage due at `now` (pure): the nearest reminder threshold reached, or EXPIRED within its window. */
export function trialNoticeStage(trialEndsAt: Date, now: Date): TrialStage | null {
  const left = trialEndsAt.getTime() - now.getTime();
  if (left <= 0) return -left <= EXPIRED_NOTICE_WINDOW_MS ? "EXPIRED" : null;
  for (const d of REMINDER_DAYS) if (left <= d * DAY_MS) return `D${d}` as TrialStage;
  return null;
}

export type TrialLifecycleRun = {
  mode: TrialLifecycleMode;
  organizations: number;
  expiredRecorded: number;
  emailsSent: number;
  emailsFailed: number;
  /** maybe delivered (timeout / 5xx …): retried only with the same key inside Resend's window. */
  emailsUncertain: number;
  alreadyHandled: number;
  /** audit mode: emails that "send" mode would send now. */
  wouldSend: number;
  errors: Array<{ organizationId: string; error: string }>;
};

const lockOrganization = (tx: Prisma.TransactionClient, organizationId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"trial-lifecycle:" + organizationId}))`;

/** Records TRIAL_EXPIRED once per (Organization, trialEndsAt). True when this call recorded it. */
async function recordExpiry(org: { id: string; trialEndsAt: Date }, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockOrganization(tx, org.id);
    const fresh = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { plan: true, trialEndsAt: true } });
    // Re-checked under the lock: still FREE with the same, ended trial.
    if (fresh.plan !== "FREE" || !fresh.trialEndsAt || fresh.trialEndsAt.getTime() !== org.trialEndsAt.getTime() || fresh.trialEndsAt > now) return false;
    const exists = await tx.entitlementEvent.findFirst({ where: { organizationId: org.id, action: "TRIAL_EXPIRED", trialEndsAt: org.trialEndsAt }, select: { id: true } });
    if (exists) return false;
    await tx.entitlementEvent.create({
      data: {
        organizationId: org.id,
        action: "TRIAL_EXPIRED",
        fromPlan: "FREE",
        toPlan: "FREE",
        trialEndsAt: org.trialEndsAt,
        reason: "The Pro trial ended; the Free plan applies. Nothing was deleted or disconnected.",
        actor: TRIAL_ACTOR,
      },
    });
    return true;
  });
}

type Claim = { id: string; daysLeft: number | null } | null;
type NoticeKey = { organizationId: string; userId: string; stage: TrialStage; trialEndsAt: Date };
type NoticeRow = { status: "SENDING" | "SENT" | "FAILED" | "UNCERTAIN"; attempts: number; claimedAt: Date; createdAt: Date };

/** Whether an existing row may be sent again now (pure). */
export function noticeRetryable(row: NoticeRow, now: Date): boolean {
  if (row.status === "SENT" || row.attempts >= MAX_ATTEMPTS) return false;
  if (row.status === "FAILED") return true;
  const maybeSent = row.status === "UNCERTAIN" || (row.status === "SENDING" && row.claimedAt.getTime() <= now.getTime() - STALE_CLAIM_MS);
  return maybeSent && now.getTime() - row.createdAt.getTime() < UNCERTAIN_RETRY_WINDOW_MS;
}

/** Claims one email: a new row, or a permitted retry of an existing one. null = handled already (or claimed by another run). */
async function claimNotice(key: NoticeKey, daysLeft: number | null, now: Date): Promise<Claim> {
  try {
    const created = await prisma.trialNotice.create({ data: { ...key, daysLeft, status: "SENDING", createdAt: now, claimedAt: now }, select: { id: true } });
    return { id: created.id, daysLeft };
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const row = await prisma.trialNotice.findUnique({
    where: { organizationId_stage_trialEndsAt_userId: key },
    select: { id: true, status: true, attempts: true, claimedAt: true, createdAt: true, daysLeft: true },
  });
  if (!row || !noticeRetryable(row, now)) return null;
  // Conditional: exactly one concurrent run wins the retry.
  const { count } = await prisma.trialNotice.updateMany({
    where: { id: row.id, status: row.status, attempts: row.attempts, claimedAt: row.claimedAt },
    data: { status: "SENDING", attempts: { increment: 1 }, claimedAt: now, lastError: null },
  });
  return count === 1 ? { id: row.id, daysLeft: row.daysLeft } : null;
}

/** Audit mode: would "send" mode send this email now? Read-only. */
async function wouldSend(key: NoticeKey, now: Date): Promise<boolean> {
  const row = await prisma.trialNotice.findUnique({ where: { organizationId_stage_trialEndsAt_userId: key }, select: { status: true, attempts: true, claimedAt: true, createdAt: true } });
  return !row || noticeRetryable(row, now);
}

export async function runTrialLifecycle(now: Date = new Date(), options: { mode?: TrialLifecycleMode } = {}): Promise<TrialLifecycleRun> {
  const mode = options.mode ?? trialLifecycleMode();
  const run: TrialLifecycleRun = { mode, organizations: 0, expiredRecorded: 0, emailsSent: 0, emailsFailed: 0, emailsUncertain: 0, alreadyHandled: 0, wouldSend: 0, errors: [] };
  if (mode === "off") return run;

  const orgs = await prisma.organization.findMany({
    where: {
      plan: "FREE",
      trialEndsAt: { gt: new Date(now.getTime() - AUDIT_LOOKBACK_MS), lte: new Date(now.getTime() + REMINDER_DAYS[REMINDER_DAYS.length - 1] * DAY_MS) },
      // Converted to Stripe Pro at some point (the trial ended by conversion, not by expiry) or paying now.
      entitlementEvents: { none: { action: "STRIPE_PRO_STARTED" } },
      billingSubscriptions: { none: { status: { in: [...ENTITLING_STATUSES] } } },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      trialEndsAt: true,
      entitlementEvents: { where: { action: "TRIAL_EXPIRED" }, select: { trialEndsAt: true } },
    },
    orderBy: { trialEndsAt: "asc" },
  });
  run.organizations = orgs.length;

  for (const org of orgs) {
    const trialEndsAt = org.trialEndsAt!;
    try {
      // 1 — audit: the trial ended (both "audit" and "send").
      const recorded = org.entitlementEvents.some((e) => e.trialEndsAt?.getTime() === trialEndsAt.getTime());
      if (trialStatus(org, now).phase === "expired" && !recorded && (await recordExpiry({ id: org.id, trialEndsAt }, now))) run.expiredRecorded++;

      // 2 — the email of the current stage, once per verified OWNER.
      const stage = trialNoticeStage(trialEndsAt, now);
      if (!stage) continue;
      const timeZone = await organizationTimeZone(org.id);
      const owners = await prisma.organizationMembership.findMany({
        where: { organizationId: org.id, role: "OWNER", user: { emailVerifiedAt: { not: null } } },
        select: { user: { select: { id: true, email: true } } },
        orderBy: { createdAt: "asc" },
      });
      for (const { user } of owners) {
        const key = { organizationId: org.id, userId: user.id, stage, trialEndsAt };
        if (mode === "audit") {
          if (await wouldSend(key, now)) run.wouldSend++;
          else run.alreadyHandled++;
          continue;
        }
        const claim = await claimNotice(key, stage === "EXPIRED" ? null : trialDaysLeft(trialEndsAt, now), now);
        if (!claim) {
          run.alreadyHandled++;
          continue;
        }
        try {
          await sendTrialEmail({
            to: user.email,
            organizationName: org.name,
            stage: stage === "EXPIRED" ? "EXPIRED" : "REMINDER",
            daysLeft: claim.daysLeft, // frozen at the first claim: a retry is byte-identical
            endsOn: trialDateLabel(trialEndsAt, timeZone),
            upgradeLine: billingConfig().enabled ? "To keep Pro, subscribe on your organization's Billing page." : upgradeHint(),
            path: `/admin/o/${encodeURIComponent(org.slug)}`,
            idempotencyKey: `trial-notice/${claim.id}`,
          });
          await prisma.trialNotice.update({ where: { id: claim.id }, data: { status: "SENT", sentAt: new Date() } });
          run.emailsSent++;
        } catch (e) {
          const status = classifySendError(e);
          const reason = e instanceof EmailDeliveryError ? `${e.reason}${e.status ? ` ${e.status}` : ""}` : e instanceof Error ? e.name : "error";
          await prisma.trialNotice.update({ where: { id: claim.id }, data: { status, lastError: reason.slice(0, 200) } });
          if (status === "UNCERTAIN") run.emailsUncertain++;
          else run.emailsFailed++;
          console.error(`[trial] email ${status === "UNCERTAIN" ? "delivery unclear" : "not sent"} (stage ${stage}): ${reason}`);
        }
      }
    } catch (e) {
      run.errors.push({ organizationId: org.id, error: e instanceof Error ? e.message : "error" });
    }
  }
  return run;
}
