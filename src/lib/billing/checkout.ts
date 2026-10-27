import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasOrgRole, type OrganizationContext } from "@/lib/tenantContext";
import { appUrl } from "@/lib/email/config";
import { effectivePlan, PLAN_LABEL, planSummary } from "@/lib/entitlements";
import { BILLING_UNAVAILABLE_MESSAGE, billingConfig, PRO_PRICES_USD, priceFor, type BillingInterval } from "@/lib/billing/config";
import { billingStripe, isTaxLocationInvalid } from "@/lib/billing/stripe";
import { verifyConfiguredPrices } from "@/lib/billing/prices";
import { verifyTaxReadiness } from "@/lib/billing/tax";
import { checkoutRequestHash, parseUsBillingAddress, US_ONLY_MESSAGE } from "@/lib/billing/address";
import { LEGAL_EFFECTIVE_DATE } from "@/lib/legal";
import { LIVE_STATUSES, syncSubscription } from "@/lib/billing/sync";
import { scheduledEnd } from "@/lib/billing/statusNote";

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
 *  - both configured Prices are verified with Stripe first (M11.2B, prices.ts);
 *  - the Stripe Customer is created with a per-Organization idempotency key and
 *    stored only if none is stored yet; a stored Customer that does not exist
 *    in this deployment's Stripe mode (M11.2B) is never used — it is replaced;
 *  - no database transaction is held open across a Stripe call;
 *  - M11.2C: the owner must accept the Terms and the recurring charge, and give a
 *    US billing address (validated here, then by Stripe Tax on the Customer);
 *    Checkout uses automatic tax and cannot change the address, and is refused
 *    unless Stripe Tax is active with the home-state registration (tax.ts);
 *  - success / cancel / return URLs are built from the trusted APP_BASE_URL;
 *  - reaching the success URL activates nothing: the server re-fetches the
 *    Checkout Session and the subscription from Stripe.
 */
const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const CHECKOUT_TTL_MS = 60 * 60_000; // Stripe allows 30 min – 24 h
/** M11.2C — the recurring-charge disclosure at the decision point (our page and Stripe Checkout). */
export function chargeNotice(interval: BillingInterval): string {
  const price = interval === "month" ? `${PRO_PRICES_USD.month} per month` : `${PRO_PRICES_USD.year} per year`;
  return `You'll be charged ${price}, plus any sales tax shown at checkout, starting today. Your subscription renews automatically every ${interval === "month" ? "month" : "year"} at the then-current price until you cancel. Cancel any time in Manage billing; Pro stays until the end of the paid period. Payments are non-refundable except as described in our Terms. Any remaining free trial ends when you subscribe.`;
}
export const TERMS_REQUIRED_MESSAGE = "Please confirm you agree to the Terms and the automatically renewing charge.";

export const billingPagePath = (organizationSlug: string) => `/admin/o/${encodeURIComponent(organizationSlug)}/billing`;

function unavailable(): NextResponse {
  return NextResponse.json({ error: BILLING_UNAVAILABLE_MESSAGE, code: "BILLING_UNAVAILABLE" }, { status: 503 });
}

async function lockBilling(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"billing:" + organizationId}))`;
}

/**
 * The Organization's Stripe Customer (created once; concurrent callers converge on one).
 * A stored Customer is first confirmed to exist in THIS deployment's mode: a
 * test-mode Customer is never sent to live Checkout (and vice versa). Only a
 * definite "not in this mode / deleted" answer replaces it; a Stripe outage throws.
 */
async function ensureCustomer(organizationId: string, name: string, livemode: boolean): Promise<string> {
  const existing = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { stripeCustomerId: true } });
  if (existing.stripeCustomerId) {
    const found = await billingStripe().retrieveCustomer(existing.stripeCustomerId);
    if (found && !found.deleted && found.livemode === livemode) return existing.stripeCustomerId;
    console.error(`[billing] organization ${organizationId}: stored Stripe Customer is not usable in ${livemode ? "live" : "test"} mode; creating a new one`);
  }
  const key = `tbp-customer${livemode ? ":live" : ""}:${organizationId}${existing.stripeCustomerId ? `:replaces:${existing.stripeCustomerId}` : ""}`;
  const customer = await billingStripe().createCustomer({ name, metadata: { organizationId } }, key);
  await prisma.organization.updateMany({ where: { id: organizationId, stripeCustomerId: existing.stripeCustomerId }, data: { stripeCustomerId: customer.id } });
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
  // M11.2C — explicit agreement to the Terms and the recurring charge, and a US billing address.
  if ((body as { acceptTerms?: unknown }).acceptTerms !== true) return NextResponse.json({ error: TERMS_REQUIRED_MESSAGE, code: "TERMS_REQUIRED" }, { status: 400 });
  const parsedAddress = parseUsBillingAddress((body as { address?: unknown }).address);
  if (!parsedAddress.ok) return NextResponse.json({ error: parsedAddress.error, code: parsedAddress.field === "country" ? "US_ONLY" : "ADDRESS_INVALID", field: parsedAddress.field ?? null }, { status: 400 });
  const address = parsedAddress.address;
  const termsVersion = LEGAL_EFFECTIVE_DATE ?? "unpublished";
  const requestHash = checkoutRequestHash(String(interval), address, termsVersion);
  const organizationId = context.organization.id;
  const now = new Date();

  // 1. Eligibility + the durable operation, under the Organization's billing lock (short, no network).
  // createdAt / createdByUserId come from the durable operation, so a retry sends Stripe IDENTICAL
  // parameters under the same idempotency key (Stripe rejects a reused key with different parameters).
  type Op = { kind: "reuse"; id: string; url: string | null; status: string; expiresAt: Date; createdAt: Date; createdByUserId: string | null } | { kind: "new"; id: string; expiresAt: Date; createdAt: Date; createdByUserId: string | null } | { kind: "refuse"; response: NextResponse };
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
    // Reused only for the SAME interval, address and terms (otherwise it is expired below like any other).
    if (pending && pending.interval === interval && pending.requestHash === requestHash) return { kind: "reuse", id: pending.id, url: pending.url, status: pending.status, expiresAt: pending.expiresAt, createdAt: pending.createdAt, createdByUserId: pending.createdByUserId };
    // Another interval's Checkout is still being created (its Stripe session id isn't known yet): don't race it.
    if (pending && pending.status === "CREATING" && !pending.stripeSessionId && pending.createdAt > new Date(now.getTime() - 2 * 60_000)) {
      return { kind: "refuse", response: NextResponse.json({ error: "Another checkout is being prepared. Please try again in a moment.", code: "CHECKOUT_IN_PROGRESS" }, { status: 409 }) };
    }
    const created = await tx.billingCheckoutSession.create({ data: { organizationId, interval: interval as BillingInterval, stripePriceId: priceId, createdByUserId: context.user.id, requestHash, expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS) } });
    return { kind: "new", id: created.id, expiresAt: created.expiresAt, createdAt: created.createdAt, createdByUserId: created.createdByUserId };
  });
  if (op.kind === "refuse") return op.response;
  if (op.kind === "reuse" && op.status === "OPEN" && op.url) return NextResponse.json({ url: op.url });

  // M11.2C: Stripe Tax must be ready (active + home-state registration) — never a silent zero-tax Checkout.
  // M11.2B: both configured Prices must be valid Prices of this mode (and tax-exclusive) before Stripe creates anything.
  const tax = await verifyTaxReadiness(config, billingStripe());
  const prices = tax.ok ? await verifyConfiguredPrices(config, billingStripe(), Date.now(), tax.defaultTaxBehavior) : ({ ok: false, problem: tax.problem } as const);
  if (!prices.ok) {
    console.error(`[billing] checkout ${op.id} refused: ${prices.problem}`);
    // A NEW operation never reached Stripe, so it can be closed. A reused one stays CREATING: Stripe may
    // already hold its session (lost response), and only its own idempotency key may recover it.
    if (op.kind === "new") await prisma.billingCheckoutSession.updateMany({ where: { id: op.id, status: "CREATING" }, data: { status: "FAILED" } });
    return unavailable();
  }

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
    const customer = await ensureCustomer(organizationId, context.organization.name, config.livemode);
    // M11.2C — the US billing address goes on the Customer (Stripe Tax validates it); Checkout can't change it.
    const updated = await billingStripe().updateCustomerAddress(customer, address);
    if (updated.addressCountry !== "US") throw new Error("Stripe did not store a US billing address.");
    const base = billingPagePath(context.organization.slug);
    const session = await billingStripe().createCheckoutSession(
      {
        mode: "subscription",
        customer,
        client_reference_id: organizationId,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { organizationId, operationId: op.id, termsVersion, termsAcceptedAt: op.createdAt.toISOString(), termsAcceptedBy: op.createdByUserId ?? context.user.id },
        subscription_data: { metadata: { organizationId, termsVersion } },
        automatic_tax: { enabled: true },
        customer_update: { address: "never" },
        billing_address_collection: "auto",
        success_url: appUrl(`${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`),
        cancel_url: appUrl(`${base}?checkout=cancel`),
        expires_at: Math.floor(op.expiresAt.getTime() / 1000),
        custom_text: { submit: { message: chargeNotice(interval as BillingInterval) } },
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
    if (isTaxLocationInvalid(e)) {
      console.error(`[billing] checkout ${op.id} refused: billing address not accepted for tax`);
      return NextResponse.json({ error: `We couldn't verify this billing address for sales tax. Check the street, city, state and ZIP code. ${US_ONLY_MESSAGE}`, code: "ADDRESS_INVALID" }, { status: 400 });
    }
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
  const noCustomer = () => NextResponse.json({ error: "There is no billing account for this organization yet.", code: "NO_CUSTOMER" }, { status: 409 });
  if (!org.stripeCustomerId) return noCustomer();
  try {
    // M11.2B: never open a Portal for a Customer of the other Stripe mode.
    const found = await billingStripe().retrieveCustomer(org.stripeCustomerId);
    if (!found || found.deleted || found.livemode !== config.livemode) return noCustomer();
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
  // M11.2C — a skipped return is logged with a reason CODE only (no ids), so "nothing happened" is diagnosable.
  const ignored = (reason: string) => {
    console.info(`[billing] checkout return ignored: ${reason}`);
    return "ignored" as const;
  };
  if (!config.enabled) return "ignored";
  if (!hasOrgRole(context, ["OWNER", "ADMIN"])) return ignored("not_owner_or_admin");
  if (typeof sessionId !== "string" || !/^cs_[\w]+$/.test(sessionId)) return ignored("session_id_format");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { id: true, stripeCustomerId: true } });
  try {
    const session = await billingStripe().retrieveCheckoutSession(sessionId);
    if (session.livemode !== config.livemode) return ignored("mode_mismatch");
    if (session.metadata?.organizationId !== org.id || session.client_reference_id !== org.id) return ignored("organization_mismatch");
    if (!org.stripeCustomerId || session.customer !== org.stripeCustomerId) return ignored("customer_mismatch");
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
    select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, cancelAt: true, endedAt: true },
  });
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { stripeCustomerId: true } });
  const isOwner = hasOrgRole(context, ["OWNER"]);
  const purchasable = summary.plan === "FREE" || summary.plan === "TRIAL";
  const liveSub = sub ? (LIVE_STATUSES as readonly string[]).includes(sub.status) : false;
  return {
    summary,
    billingEnabled: config.enabled,
    prices: PRO_PRICES_USD,
    subscription: sub
      ? { status: sub.status, interval: sub.interval, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, accessEndsAt: scheduledEnd(sub)?.toISOString() ?? null, endedAt: sub.endedAt?.toISOString() ?? null }
      : null,
    isOwner,
    canPurchase: config.enabled && isOwner && purchasable && !liveSub,
    canManage: config.enabled && isOwner && Boolean(org.stripeCustomerId),
  };
}
