import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasOrgRole, type OrganizationContext } from "@/lib/tenantContext";
import { appUrl } from "@/lib/email/config";
import { effectivePlan, PLAN_LABEL, planSummary } from "@/lib/entitlements";
import { BILLING_UNAVAILABLE_MESSAGE, billingConfig, PRO_PRICES_USD, priceFor, type BillingInterval } from "@/lib/billing/config";
import { billingStripe } from "@/lib/billing/stripe";
import { LIVE_STATUSES, syncSubscription } from "@/lib/billing/sync";

/**
 * M11.2A — OWNER-only Checkout and Customer Portal, and the billing view
 * (OWNER + ADMIN read-only; MEMBER / foreign → the generic 404).
 *
 * Checkout safety:
 *  - the browser sends ONLY "month" | "year"; the Price comes from the server allow-list;
 *  - the Organization comes from the URL + membership; its plan must be FREE
 *    (or a running trial) — LEGACY / COMP / PRO and any live subscription → 409;
 *  - one durable operation (BillingCheckoutSession) per attempt, created under
 *    the Organization lock (at most one CREATING/OPEN per Organization); its id
 *    is the Stripe idempotency key, so retries, double clicks, timeouts and a
 *    crash after Stripe succeeded all return the SAME Checkout Session;
 *  - the Stripe Customer is created with a per-Organization idempotency key and
 *    stored only if none is stored yet;
 *  - no database transaction is held open across a Stripe call;
 *  - success / cancel / return URLs are built from the trusted APP_BASE_URL;
 *  - reaching the success URL activates nothing: the server re-fetches the
 *    Checkout Session and the subscription from Stripe.
 */
const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const CHECKOUT_TTL_MS = 60 * 60_000; // Stripe allows 30 min – 24 h
export const CHECKOUT_CHARGE_NOTICE = "Pro billing starts today. Any remaining free trial ends when you subscribe. Your subscription renews automatically until you cancel.";

export const billingPagePath = (organizationSlug: string) => `/admin/o/${encodeURIComponent(organizationSlug)}/billing`;

function unavailable(): NextResponse {
  return NextResponse.json({ error: BILLING_UNAVAILABLE_MESSAGE, code: "BILLING_UNAVAILABLE" }, { status: 503 });
}

async function lockBilling(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"billing:" + organizationId}))`;
}

/** The Organization's Stripe Customer (created once; concurrent callers converge on one). */
async function ensureCustomer(organizationId: string, name: string): Promise<string> {
  const existing = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { stripeCustomerId: true } });
  if (existing.stripeCustomerId) return existing.stripeCustomerId;
  const customer = await billingStripe().createCustomer({ name, metadata: { organizationId } }, `tbp-customer:${organizationId}`);
  await prisma.organization.updateMany({ where: { id: organizationId, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } });
  const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { stripeCustomerId: true } });
  return stored.stripeCustomerId!;
}

function isTransient(e: unknown): boolean {
  const type = (e as { type?: string })?.type ?? "";
  return /StripeConnectionError|StripeAPIError|StripeRateLimitError|StripeIdempotencyError/.test(type) || (e as { name?: string })?.name === "AbortError" || /timeout|ECONN|network/i.test(String((e as Error)?.message ?? ""));
}

export async function startCheckout(context: OrganizationContext, body: unknown): Promise<NextResponse> {
  if (!hasOrgRole(context, ["OWNER"])) return NOT_FOUND();
  const config = billingConfig();
  if (!config.enabled) return unavailable();
  const interval = (body as { interval?: unknown } | null)?.interval;
  const priceId = priceFor(config, interval);
  if (!priceId) return NextResponse.json({ error: "Choose monthly or annual billing." }, { status: 400 });
  const organizationId = context.organization.id;
  const now = new Date();

  // 1. Eligibility + the durable operation, under the Organization's billing lock (short, no network).
  type Op = { kind: "reuse"; id: string; url: string | null; status: string; expiresAt: Date } | { kind: "new"; id: string; expiresAt: Date } | { kind: "refuse"; response: NextResponse };
  const op: Op = await prisma.$transaction(async (tx) => {
    await lockBilling(tx, organizationId);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, trialEndsAt: true } });
    const plan = effectivePlan(org, now);
    if (plan === "LEGACY" || plan === "COMP") {
      return { kind: "refuse", response: NextResponse.json({ error: `Your organization has ${PLAN_LABEL[plan]} access — no Pro subscription is needed.`, code: "NOT_ELIGIBLE" }, { status: 409 }) };
    }
    const live = await tx.billingSubscription.findFirst({ where: { organizationId, status: { in: [...LIVE_STATUSES] } }, select: { status: true } });
    if (plan === "PRO" || live) {
      return { kind: "refuse", response: NextResponse.json({ error: "This organization already has a subscription. Use Manage billing to change it.", code: "ALREADY_SUBSCRIBED" }, { status: 409 }) };
    }
    const pending = await tx.billingCheckoutSession.findFirst({ where: { organizationId, status: { in: ["CREATING", "OPEN"] }, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
    if (pending && pending.interval === interval) return { kind: "reuse", id: pending.id, url: pending.url, status: pending.status, expiresAt: pending.expiresAt };
    // Another interval's Checkout is still being created (its Stripe session id isn't known yet): don't race it.
    if (pending && pending.status === "CREATING" && !pending.stripeSessionId && pending.createdAt > new Date(now.getTime() - 2 * 60_000)) {
      return { kind: "refuse", response: NextResponse.json({ error: "Another checkout is being prepared. Please try again in a moment.", code: "CHECKOUT_IN_PROGRESS" }, { status: 409 }) };
    }
    const created = await tx.billingCheckoutSession.create({ data: { organizationId, interval: interval as BillingInterval, stripePriceId: priceId, createdByUserId: context.user.id, expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS) } });
    return { kind: "new", id: created.id, expiresAt: created.expiresAt };
  });
  if (op.kind === "refuse") return op.response;
  if (op.kind === "reuse" && op.status === "OPEN" && op.url) return NextResponse.json({ url: op.url });

  try {
    // 2. Any OTHER open Checkout of this Organization (e.g. the other interval) is expired on
    //    Stripe first — and marked EXPIRED only after Stripe confirms — so two sessions are never payable.
    const others = await prisma.billingCheckoutSession.findMany({ where: { organizationId, id: { not: op.id }, status: { in: ["CREATING", "OPEN"] }, stripeSessionId: { not: null } }, select: { id: true, stripeSessionId: true } });
    for (const other of others) {
      const old = await billingStripe().expireCheckoutSession(other.stripeSessionId!).catch(async (e) => {
        if (isTransient(e)) throw e;
        return billingStripe().retrieveCheckoutSession(other.stripeSessionId!); // already expired / completed: read its final state
      });
      if (old.status === "complete") {
        await prisma.billingCheckoutSession.updateMany({ where: { id: other.id }, data: { status: "COMPLETED" } });
        await prisma.billingCheckoutSession.updateMany({ where: { id: op.id, status: "CREATING" }, data: { status: "FAILED" } });
        if (old.subscription) await syncSubscription(old.subscription, { actor: `checkout:${context.user.id}` }).catch(() => {});
        return NextResponse.json({ error: "A checkout for this organization was just completed. Refresh the billing page.", code: "ALREADY_SUBSCRIBED" }, { status: 409 });
      }
      await prisma.billingCheckoutSession.updateMany({ where: { id: other.id }, data: { status: "EXPIRED" } });
    }
    // 3. Stripe calls (idempotent: same operation → same Customer / Session).
    const customer = await ensureCustomer(organizationId, context.organization.name);
    const base = billingPagePath(context.organization.slug);
    const session = await billingStripe().createCheckoutSession(
      {
        mode: "subscription",
        customer,
        client_reference_id: organizationId,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { organizationId, operationId: op.id },
        subscription_data: { metadata: { organizationId } },
        success_url: appUrl(`${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`),
        cancel_url: appUrl(`${base}?checkout=cancel`),
        expires_at: Math.floor(op.expiresAt.getTime() / 1000),
        custom_text: { submit: { message: CHECKOUT_CHARGE_NOTICE } },
        allow_promotion_codes: false,
      },
      `tbp-checkout:${op.id}`
    );
    if (session.metadata?.organizationId !== organizationId || session.customer !== customer) throw new Error("Stripe returned an unexpected Checkout Session.");
    await prisma.billingCheckoutSession.updateMany({ where: { id: op.id, status: "CREATING" }, data: { status: "OPEN", stripeSessionId: session.id, url: session.url } });
    if (!session.url) throw new Error("Stripe returned no Checkout URL.");
    return NextResponse.json({ url: session.url });
  } catch (e) {
    if (isTransient(e)) {
      // The operation stays CREATING: the next click retries it with the SAME idempotency key.
      console.error(`[billing] checkout ${op.id} transient failure: ${(e as Error)?.message ?? "error"}`);
      return NextResponse.json({ error: "Stripe didn't respond. Please try again.", code: "STRIPE_UNAVAILABLE" }, { status: 503 });
    }
    await prisma.billingCheckoutSession.updateMany({ where: { id: op.id, status: "CREATING" }, data: { status: "FAILED" } });
    console.error(`[billing] checkout ${op.id} failed: ${(e as Error)?.message ?? "error"}`);
    return NextResponse.json({ error: "Checkout could not be started. Please try again later." }, { status: 502 });
  }
}

/** OWNER-only Customer Portal for THIS Organization's own Stripe Customer. */
export async function openPortal(context: OrganizationContext): Promise<NextResponse> {
  if (!hasOrgRole(context, ["OWNER"])) return NOT_FOUND();
  const config = billingConfig();
  if (!config.enabled) return unavailable();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { stripeCustomerId: true } });
  if (!org.stripeCustomerId) return NextResponse.json({ error: "There is no billing account for this organization yet.", code: "NO_CUSTOMER" }, { status: 409 });
  try {
    const portal = await billingStripe().createPortalSession({
      customer: org.stripeCustomerId,
      return_url: appUrl(billingPagePath(context.organization.slug)),
      ...(config.portalConfigurationId ? { configuration: config.portalConfigurationId } : {}),
    });
    return NextResponse.json({ url: portal.url });
  } catch (e) {
    console.error(`[billing] portal failed: ${(e as Error)?.message ?? "error"}`);
    return NextResponse.json({ error: "Billing management is temporarily unavailable. Please try again." }, { status: 503 });
  }
}

/**
 * The success redirect: verify the Checkout Session with Stripe (it must be
 * this Organization's, for its Customer) and apply the subscription's REAL
 * state. Reaching the URL alone changes nothing.
 */
export async function confirmCheckoutReturn(context: OrganizationContext, sessionId: unknown): Promise<"applied" | "pending" | "ignored"> {
  const config = billingConfig();
  if (!config.enabled || !hasOrgRole(context, ["OWNER", "ADMIN"]) || typeof sessionId !== "string" || !/^cs_[\w]+$/.test(sessionId)) return "ignored";
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { id: true, stripeCustomerId: true } });
  try {
    const session = await billingStripe().retrieveCheckoutSession(sessionId);
    if (session.livemode !== config.livemode || session.metadata?.organizationId !== org.id || session.client_reference_id !== org.id || !org.stripeCustomerId || session.customer !== org.stripeCustomerId) return "ignored";
    if (session.status !== "complete" || !session.subscription) return "pending";
    await syncSubscription(session.subscription, { actor: `checkout-return:${context.user.id}` });
    await prisma.billingCheckoutSession.updateMany({ where: { stripeSessionId: session.id, status: { in: ["CREATING", "OPEN"] } }, data: { status: "COMPLETED" } });
    return "applied";
  } catch (e) {
    console.error(`[billing] checkout return ${sessionId}: ${(e as Error)?.message ?? "error"}`);
    return "pending"; // the webhook / reconciliation will apply it
  }
}

/** Read-only billing view (OWNER + ADMIN). No card or payment-method data exists here. */
export async function billingView(context: OrganizationContext) {
  if (!hasOrgRole(context, ["OWNER", "ADMIN"])) return null;
  const config = billingConfig();
  const summary = await planSummary(context.organization.id);
  const sub = await prisma.billingSubscription.findFirst({
    where: { organizationId: context.organization.id },
    orderBy: [{ updatedAt: "desc" }],
    select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, endedAt: true },
  });
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { stripeCustomerId: true } });
  const isOwner = hasOrgRole(context, ["OWNER"]);
  const purchasable = summary.plan === "FREE" || summary.plan === "TRIAL";
  const liveSub = sub ? (LIVE_STATUSES as readonly string[]).includes(sub.status) : false;
  return {
    summary,
    billingEnabled: config.enabled,
    prices: PRO_PRICES_USD,
    subscription: sub ? { status: sub.status, interval: sub.interval, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, endedAt: sub.endedAt?.toISOString() ?? null } : null,
    isOwner,
    canPurchase: config.enabled && isOwner && purchasable && !liveSub,
    canManage: config.enabled && isOwner && Boolean(org.stripeCustomerId),
  };
}
