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
  /** M11.2B — when a scheduled cancellation takes effect (the Customer Portal sets this; cancel_at_period_end stays false). */
  cancel_at: number | null;
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

export type StripePriceLite = {
  id: string;
  livemode: boolean;
  active: boolean;
  type: string;
  currency: string;
  unit_amount: number | null;
  product: string | null;
  /** M11.2C — "exclusive" (tax added on top), "inclusive", or "unspecified" (Stripe Tax settings default). */
  tax_behavior: string | null;
  recurring: { interval: string; interval_count: number; usage_type: string } | null;
};
/** M11.2C — only the address COUNTRY is read back (US-only check); the full address stays in Stripe. */
export type StripeCustomerLite = { id: string; livemode: boolean; deleted: boolean; addressCountry?: string | null };
/** M11.2C — a validated US billing address (src/lib/billing/address.ts). */
export type BillingAddress = { line1: string; line2: string | null; city: string; state: string; postal_code: string; country: "US" };
/** M11.2C — Stripe Tax readiness, as read from the account (never written by the app). */
export type StripeTaxSettingsLite = { status: string; defaultTaxBehavior: string | null };
export type StripeTaxRegistrationLite = { country: string; state: string | null };

export interface BillingStripe {
  retrievePrice(id: string): Promise<StripePriceLite>;
  /** null when the Customer does not exist in THIS key's mode (e.g. a test Customer seen with a live key). */
  retrieveCustomer(id: string): Promise<StripeCustomerLite | null>;
  createCustomer(params: { name: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  /** M11.2C — set the Customer's billing address; Stripe Tax validates it immediately (error code customer_tax_location_invalid). */
  updateCustomerAddress(id: string, address: BillingAddress): Promise<StripeCustomerLite>;
  retrieveTaxSettings(): Promise<StripeTaxSettingsLite>;
  listActiveTaxRegistrations(): Promise<StripeTaxRegistrationLite[]>;
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
    cancel_at: s.cancel_at ?? null,
    canceled_at: s.canceled_at ?? null,
    ended_at: s.ended_at ?? null,
    metadata: (s.metadata ?? {}) as Record<string, string>,
    items: { data: s.items.data.map((i) => ({ price: { id: i.price.id }, current_period_end: i.current_period_end })) },
  };
}
export function toPriceLite(p: Stripe.Price): StripePriceLite {
  return {
    id: p.id,
    livemode: p.livemode,
    active: p.active,
    type: p.type,
    currency: p.currency,
    unit_amount: p.unit_amount ?? null,
    product: ref(p.product),
    recurring: p.recurring ? { interval: p.recurring.interval, interval_count: p.recurring.interval_count, usage_type: p.recurring.usage_type } : null,
    tax_behavior: p.tax_behavior ?? null,
  };
}
/** M11.2C — Stripe Tax could not place the address (invalid / unsupported for tax). */
export function isTaxLocationInvalid(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "customer_tax_location_invalid";
}
/** Stripe's "No such …" error (the object does not exist for this key / mode). */
export function isResourceMissing(e: unknown): boolean {
  const err = e as { type?: string; code?: string; statusCode?: number } | null;
  return Boolean(err && (err.code === "resource_missing" || (err.type === "StripeInvalidRequestError" && err.statusCode === 404)));
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
    async retrievePrice(id) {
      return toPriceLite(await stripe.prices.retrieve(id));
    },
    async retrieveCustomer(id) {
      try {
        const c = await stripe.customers.retrieve(id);
        const deleted = Boolean((c as { deleted?: boolean }).deleted);
        return { id: c.id, livemode: "livemode" in c ? c.livemode : false, deleted, addressCountry: deleted ? null : ((c as Stripe.Customer).address?.country ?? null) };
      } catch (e) {
        if (isResourceMissing(e)) return null;
        throw e;
      }
    },
    async createCustomer(params, idempotencyKey) {
      const c = await stripe.customers.create(params, { idempotencyKey });
      return { id: c.id };
    },
    async updateCustomerAddress(id, address) {
      const c = await stripe.customers.update(id, { address: { ...address, line2: address.line2 ?? "" }, tax: { validate_location: "immediately" } });
      return { id: c.id, livemode: c.livemode, deleted: false, addressCountry: c.address?.country ?? null };
    },
    async retrieveTaxSettings() {
      const s = await stripe.tax.settings.retrieve();
      return { status: s.status, defaultTaxBehavior: s.defaults?.tax_behavior ?? null };
    },
    async listActiveTaxRegistrations() {
      const out: StripeTaxRegistrationLite[] = [];
      for await (const r of stripe.tax.registrations.list({ status: "active", limit: 100 })) out.push({ country: r.country, state: r.country_options?.us?.state ?? null });
      return out;
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

/** The Stripe client for an ENABLED billing configuration (live keys only in Vercel Production — see config). */
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
