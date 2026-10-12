import type { OrganizationPlan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { billingConfig, intervalForPrice } from "@/lib/billing/config";
import { billingStripe, type StripeSubscriptionLite } from "@/lib/billing/stripe";

/**
 * M11.2A — Stripe subscription → local state + entitlement projection.
 *
 * Always works from the subscription RE-FETCHED from Stripe (never the event
 * payload), so duplicated / out-of-order events converge to Stripe's current
 * state. The network call happens BEFORE the short database transaction; the
 * transaction takes the Organization's entitlement lock (same lock as M11.1
 * capacity checks), upserts BillingSubscription (an older fetch never
 * overwrites a newer one), recomputes Organization.plan and — when called for
 * a webhook event — marks that event PROCESSED in the same commit.
 *
 * Mapping (subscription status → entitlement):
 *   active, trialing, past_due (grace while Stripe retries) → PRO
 *   active + cancel_at_period_end                          → PRO until Stripe ends it
 *   unpaid, canceled, incomplete, incomplete_expired, paused → no Pro from this subscription
 * Organization.plan: FREE ↔ PRO only. LEGACY / COMP are never changed here.
 * Converting to paid ends any running introductory trial (billing starts
 * immediately), so when paid Pro ends the Organization is FREE — no new trial.
 * Nothing is deleted on downgrade (M11.1 limits apply).
 */
export const ENTITLING_STATUSES = ["active", "trialing", "past_due"] as const;
/** A subscription in one of these states blocks a new Checkout (manage it in the Portal instead). */
export const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] as const;

export function statusEntitlesPro(status: string): boolean {
  return (ENTITLING_STATUSES as readonly string[]).includes(status);
}

/** Not retryable by Stripe: needs an operator (recorded as a StripeEvent EXCEPTION, never discarded). */
export class BillingException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingException";
  }
}

export type SyncResult = { organizationId: string; plan: OrganizationPlan; changed: boolean; stale: boolean; warning: string | null };

const ts = (n: number | null | undefined) => (typeof n === "number" ? new Date(n * 1000) : null);

/** Validate that a Stripe subscription belongs to the Organization it names (metadata + stored Customer). */
async function owningOrganization(sub: StripeSubscriptionLite, livemode: boolean) {
  if (sub.livemode !== livemode) throw new BillingException(`Subscription ${sub.id} is in the wrong Stripe mode.`);
  const organizationId = sub.metadata?.organizationId;
  if (!organizationId) throw new BillingException(`Subscription ${sub.id} has no organizationId metadata.`);
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, stripeCustomerId: true } });
  if (!org) throw new BillingException(`Subscription ${sub.id} names an unknown Organization.`);
  if (!org.stripeCustomerId || org.stripeCustomerId !== sub.customer) throw new BillingException(`Subscription ${sub.id}: customer does not match the Organization's Stripe Customer.`);
  return org.id;
}

async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"entitlement:" + organizationId}))`;
}

/** Re-fetch one subscription from Stripe and apply it. Throws BillingException (operator) or a transient error (retry). */
export async function syncSubscription(subscriptionId: string, source: { actor: string; eventId?: string }): Promise<SyncResult> {
  const config = billingConfig();
  if (!config.enabled) throw new Error("Billing is not enabled.");
  const fetchedAt = new Date();
  const sub = await billingStripe().retrieveSubscription(subscriptionId);
  const organizationId = await owningOrganization(sub, config.livemode);
  const priceId = sub.items.data[0]?.price.id ?? null;
  const interval = intervalForPrice(config, priceId);
  const periodEnds = sub.items.data.map((i) => i.current_period_end).filter((n) => typeof n === "number");
  const row = {
    organizationId,
    stripeCustomerId: sub.customer,
    stripePriceId: priceId,
    interval,
    status: sub.status,
    currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: ts(sub.canceled_at),
    endedAt: ts(sub.ended_at),
    livemode: sub.livemode,
    lastSyncedAt: fetchedAt,
  };
  const warnings: string[] = [];
  if (!interval) warnings.push(`Subscription ${sub.id} uses a Price outside the allow-list (${priceId ?? "none"}).`);

  return prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const existing = await tx.billingSubscription.findUnique({ where: { stripeSubscriptionId: sub.id }, select: { lastSyncedAt: true, organizationId: true } });
    if (existing && existing.organizationId !== organizationId) throw new BillingException(`Subscription ${sub.id} moved between Organizations.`);
    const stale = Boolean(existing && existing.lastSyncedAt > fetchedAt); // a newer fetch already wrote this row
    if (!stale) {
      await tx.billingSubscription.upsert({ where: { stripeSubscriptionId: sub.id }, update: row, create: { stripeSubscriptionId: sub.id, ...row } });
    }
    const entitling = await tx.billingSubscription.findMany({ where: { organizationId, status: { in: [...ENTITLING_STATUSES] } }, select: { stripeSubscriptionId: true } });
    if (entitling.length > 1) warnings.push(`Organization ${organizationId} has ${entitling.length} entitling subscriptions (${entitling.map((e) => e.stripeSubscriptionId).join(", ")}).`);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, trialEndsAt: true } });
    let plan = org.plan;
    let changed = false;
    const now = new Date();
    if (org.plan === "FREE" && entitling.length > 0) {
      const endTrial = org.trialEndsAt && org.trialEndsAt > now;
      plan = "PRO";
      changed = true;
      await tx.organization.update({ where: { id: organizationId }, data: { plan, ...(endTrial ? { trialEndsAt: now } : {}) } });
      await tx.entitlementEvent.create({
        data: { organizationId, action: "STRIPE_PRO_STARTED", fromPlan: "FREE", toPlan: "PRO", trialEndsAt: endTrial ? now : org.trialEndsAt, reason: `Stripe subscription ${sub.id} is ${sub.status}.${endTrial ? " The introductory trial ended at conversion (billing started immediately)." : ""}`, actor: source.actor },
      });
    } else if (org.plan === "PRO" && entitling.length === 0) {
      plan = "FREE";
      changed = true;
      await tx.organization.update({ where: { id: organizationId }, data: { plan } });
      await tx.entitlementEvent.create({
        data: { organizationId, action: "STRIPE_PRO_ENDED", fromPlan: "PRO", toPlan: "FREE", trialEndsAt: org.trialEndsAt, reason: `Stripe subscription ${sub.id} is ${sub.status}. Nothing was deleted; Free limits apply.`, actor: source.actor },
      });
    } else if ((org.plan === "LEGACY" || org.plan === "COMP") && entitling.length > 0) {
      warnings.push(`Organization ${organizationId} is ${org.plan} and has a paid subscription — not converted automatically.`);
    }
    const warning = warnings.length ? warnings.join(" ") : null;
    if (source.eventId) {
      await tx.stripeEvent.update({ where: { id: source.eventId }, data: { status: "PROCESSED", processedAt: now, organizationId, objectId: sub.id, error: warning } });
    }
    return { organizationId, plan, changed, stale, warning };
  });
}

export type ReconcileResult = { synced: number; discovered: number; checkoutsResolved: number; eventsRecovered: number; exceptions: number; failures: number };

/**
 * Recover missed webhooks and inconsistent projections — independent of the
 * match-automation scheduler, safe to run any number of times (no duplicate
 * audit events: only real plan changes are audited).
 */
export async function reconcileBilling(now: Date = new Date()): Promise<ReconcileResult> {
  const result: ReconcileResult = { synced: 0, discovered: 0, checkoutsResolved: 0, eventsRecovered: 0, exceptions: 0, failures: 0 };
  const stripe = billingStripe();
  const done = new Set<string>();
  // A reconcile-time exception without a webhook event is recorded under a synthetic id so an operator sees it too.
  const syntheticId = (subscriptionId: string) => `reconcile:${subscriptionId}`;
  const sync = async (subscriptionId: string, eventId?: string) => {
    try {
      await syncSubscription(subscriptionId, { actor: "billing:reconcile", eventId });
      await prisma.stripeEvent.updateMany({ where: { id: syntheticId(subscriptionId), status: "EXCEPTION" }, data: { status: "PROCESSED", processedAt: new Date(), error: null } });
      done.add(subscriptionId);
      result.synced++;
      return true;
    } catch (e) {
      const message = (e instanceof Error ? e.message : "error").slice(0, 300);
      if (e instanceof BillingException) {
        if (eventId) await prisma.stripeEvent.update({ where: { id: eventId }, data: { status: "EXCEPTION", error: message } });
        else
          await prisma.stripeEvent.upsert({
            where: { id: syntheticId(subscriptionId) },
            update: { status: "EXCEPTION", error: message, attempts: { increment: 1 } },
            create: { id: syntheticId(subscriptionId), type: "reconcile.subscription", livemode: false, status: "EXCEPTION", objectId: subscriptionId, error: message, attempts: 1 },
          });
      } else result.failures++;
      console.error(`[billing] reconcile ${subscriptionId}: ${message}`);
      return false;
    }
  };

  // 1. Webhook events that never committed (transient failure / exception) — re-apply from Stripe's current state.
  const stuck = await prisma.stripeEvent.findMany({ where: { status: { in: ["RECEIVED", "FAILED", "EXCEPTION"] }, objectId: { startsWith: "sub_" } }, select: { id: true, objectId: true } });
  for (const e of stuck) {
    const synthetic = e.id.startsWith("reconcile:");
    if (await sync(e.objectId!, synthetic ? undefined : e.id)) result.eventsRecovered++;
  }

  // 2. Every subscription that is not finished.
  const open = await prisma.billingSubscription.findMany({ where: { status: { notIn: ["canceled", "incomplete_expired"] } }, select: { stripeSubscriptionId: true } });
  for (const s of open) if (!done.has(s.stripeSubscriptionId)) await sync(s.stripeSubscriptionId);

  // 3. Subscriptions Stripe knows but we never saw (missed created events).
  const customers = await prisma.organization.findMany({ where: { stripeCustomerId: { not: null } }, select: { stripeCustomerId: true } });
  for (const c of customers) {
    try {
      for (const s of await stripe.listSubscriptions(c.stripeCustomerId!)) {
        if (done.has(s.id)) continue;
        const known = await prisma.billingSubscription.findUnique({ where: { stripeSubscriptionId: s.id }, select: { id: true } });
        if (!known) result.discovered++;
        await sync(s.id);
      }
    } catch (e) {
      result.failures++;
      console.error(`[billing] reconcile customer: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  // 4. Checkout attempts: completed ones are applied; abandoned ones are closed.
  const checkouts = await prisma.billingCheckoutSession.findMany({ where: { OR: [{ status: "OPEN", expiresAt: { lte: now } }, { status: "CREATING", createdAt: { lte: new Date(now.getTime() - 60 * 60_000) } }] } });
  for (const c of checkouts) {
    if (c.status === "CREATING" || !c.stripeSessionId) {
      await prisma.billingCheckoutSession.updateMany({ where: { id: c.id, status: "CREATING" }, data: { status: "FAILED" } }); // its URL never reached a browser
      result.checkoutsResolved++;
      continue;
    }
    try {
      const s = await stripe.retrieveCheckoutSession(c.stripeSessionId);
      if (s.status === "complete" && s.subscription) await sync(s.subscription);
      await prisma.billingCheckoutSession.updateMany({ where: { id: c.id, status: "OPEN" }, data: { status: s.status === "complete" ? "COMPLETED" : "EXPIRED" } });
      result.checkoutsResolved++;
    } catch {
      result.failures++;
    }
  }
  // Open exceptions an operator must look at (webhook or reconcile).
  result.exceptions = await prisma.stripeEvent.count({ where: { status: "EXCEPTION" } });
  return result;
}
