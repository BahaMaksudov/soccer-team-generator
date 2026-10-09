import Stripe from "stripe";
import { billingConfig } from "@/lib/billing/config";

/**
 * M11.2A — the ONLY Stripe surface the app uses (server-only), as a small
 * interface so tests can substitute a fake (setBillingStripeForTests). The
 * real client pins the API version of the installed SDK (stripe@23.0.0 →
 * 2026-09-30.endive), uses Stripe idempotency keys for every create, a 10 s
 * timeout and SDK network retries. Webhook signatures are verified with the
 * SDK's offline helper (no network).
 */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

export type StripeSubscriptionLite = {
  id: string;
  customer: string;
  status: string;
  livemode: boolean;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  metadata: Record<string, string>;
  items: { data: Array<{ price: { id: string }; current_period_end: number }> };
};
export type StripeCheckoutSessionLite = {
  id: string;
  url: string | null;
  status: string | null;
  customer: string | null;
  subscription: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  livemode: boolean;
};

export interface BillingStripe {
  createCustomer(params: { name: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(params: Stripe.Checkout.SessionCreateParams, idempotencyKey: string): Promise<StripeCheckoutSessionLite>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSessionLite>;
  expireCheckoutSession(id: string): Promise<StripeCheckoutSessionLite>;
  retrieveSubscription(id: string): Promise<StripeSubscriptionLite>;
  listSubscriptions(customer: string): Promise<StripeSubscriptionLite[]>;
  createPortalSession(params: { customer: string; return_url: string; configuration?: string }): Promise<{ url: string }>;
  constructEvent(rawBody: string, signature: string, secret: string): Stripe.Event;
}

const ref = (x: unknown): string | null => (typeof x === "string" ? x : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : null);

export function toSubscriptionLite(s: Stripe.Subscription): StripeSubscriptionLite {
  return {
    id: s.id,
    customer: ref(s.customer) ?? "",
    status: s.status,
    livemode: s.livemode,
    cancel_at_period_end: s.cancel_at_period_end,
    canceled_at: s.canceled_at ?? null,
    ended_at: s.ended_at ?? null,
    metadata: (s.metadata ?? {}) as Record<string, string>,
    items: { data: s.items.data.map((i) => ({ price: { id: i.price.id }, current_period_end: i.current_period_end })) },
  };
}
export function toSessionLite(s: Stripe.Checkout.Session): StripeCheckoutSessionLite {
  return {
    id: s.id,
    url: s.url ?? null,
    status: s.status ?? null,
    customer: ref(s.customer),
    subscription: ref(s.subscription),
    client_reference_id: s.client_reference_id ?? null,
    metadata: (s.metadata ?? null) as Record<string, string> | null,
    livemode: s.livemode,
  };
}

function realStripe(secretKey: string): BillingStripe {
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, timeout: 10_000, maxNetworkRetries: 2, appInfo: { name: "Team Balance Pro" } });
  return {
    async createCustomer(params, idempotencyKey) {
      const c = await stripe.customers.create(params, { idempotencyKey });
      return { id: c.id };
    },
    async createCheckoutSession(params, idempotencyKey) {
      return toSessionLite(await stripe.checkout.sessions.create(params, { idempotencyKey }));
    },
    async retrieveCheckoutSession(id) {
      return toSessionLite(await stripe.checkout.sessions.retrieve(id));
    },
    async expireCheckoutSession(id) {
      return toSessionLite(await stripe.checkout.sessions.expire(id));
    },
    async retrieveSubscription(id) {
      return toSubscriptionLite(await stripe.subscriptions.retrieve(id));
    },
    async listSubscriptions(customer) {
      const res = await stripe.subscriptions.list({ customer, status: "all", limit: 20 });
      return res.data.map(toSubscriptionLite);
    },
    async createPortalSession(params) {
      const p = await stripe.billingPortal.sessions.create(params);
      return { url: p.url };
    },
    constructEvent(rawBody, signature, secret) {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    },
  };
}

let override: BillingStripe | null = null;
/** Tests only: substitute a fake Stripe (null restores the real client). */
export function setBillingStripeForTests(fake: BillingStripe | null) {
  override = fake;
}

/** The Stripe client for an ENABLED billing configuration (never for live keys in M11.2A — see config). */
export function billingStripe(): BillingStripe {
  if (override) return override;
  const config = billingConfig();
  if (!config.enabled) throw new Error("Billing is not enabled.");
  return realStripe(config.secretKey);
}

/** Offline signature helper for tests (no network). */
export function generateTestSignature(payload: string, secret: string, timestamp?: number): string {
  return new Stripe("sk_test_offline_signature_helper", { apiVersion: STRIPE_API_VERSION }).webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });
}
/** Offline signature verification shared by the real and fake adapters. */
export function verifyStripeSignature(rawBody: string, signature: string, secret: string): Stripe.Event {
  return new Stripe("sk_test_offline_signature_helper", { apiVersion: STRIPE_API_VERSION }).webhooks.constructEvent(rawBody, signature, secret);
}
