import type Stripe from "stripe";
import { verifyStripeSignature, type BillingStripe, type StripeCheckoutSessionLite, type StripeSubscriptionLite } from "@/lib/billing/stripe";

/**
 * M11.2A — in-memory Stripe for tests (no network). Mimics the parts the app
 * uses, including Stripe idempotency keys (same key → same object) and
 * injectable failures: an outage before Stripe does anything, or a "crash"
 * after Stripe created the object (the response is lost but the object exists).
 */
type Failure = "none" | "outage" | "lost_response";
const stripeError = (type: string, message: string) => Object.assign(new Error(message), { type });

export function createFakeStripe(options: { livemode?: boolean } = {}) {
  const livemode = options.livemode ?? false;
  let seq = 0;
  const id = (prefix: string) => `${prefix}_fake${++seq}`;
  const idem = new Map<string, unknown>();
  const customers = new Map<string, { id: string; name: string; metadata: Record<string, string> }>();
  const sessions = new Map<string, StripeCheckoutSessionLite & { price: string; subscriptionMetadata: Record<string, string>; params: Stripe.Checkout.SessionCreateParams }>();
  const subs = new Map<string, StripeSubscriptionLite>();
  const failNext: Record<string, Failure> = {};
  const calls: Record<string, number> = {};
  const portalCalls: Array<{ customer: string; return_url: string }> = [];
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const failure = (k: string) => {
    const f = failNext[k] ?? "none";
    failNext[k] = "none";
    return f;
  };

  const api: BillingStripe = {
    async createCustomer(params, key) {
      count("createCustomer");
      if (idem.has(key)) return { id: (idem.get(key) as { id: string }).id };
      const f = failure("createCustomer");
      if (f === "outage") throw stripeError("StripeConnectionError", "connection timeout");
      const c = { id: id("cus"), ...params };
      customers.set(c.id, c);
      idem.set(key, c);
      if (f === "lost_response") throw stripeError("StripeConnectionError", "timeout after create");
      return { id: c.id };
    },
    async createCheckoutSession(params, key) {
      count("createCheckoutSession");
      if (idem.has(key)) return { ...(idem.get(key) as StripeCheckoutSessionLite) };
      const f = failure("createCheckoutSession");
      if (f === "outage") throw stripeError("StripeConnectionError", "connection timeout");
      const sid = id("cs_test");
      const s = {
        id: sid,
        url: `https://checkout.stripe.test/c/${sid}`,
        status: "open",
        customer: String(params.customer),
        subscription: null,
        client_reference_id: params.client_reference_id ?? null,
        metadata: (params.metadata ?? null) as Record<string, string> | null,
        livemode,
        price: String(params.line_items?.[0]?.price),
        subscriptionMetadata: (params.subscription_data?.metadata ?? {}) as Record<string, string>,
        params,
      };
      sessions.set(sid, s);
      idem.set(key, s);
      if (f === "lost_response") throw stripeError("StripeConnectionError", "timeout after create");
      return { ...s };
    },
    async retrieveCheckoutSession(sid) {
      count("retrieveCheckoutSession");
      const s = sessions.get(sid);
      if (!s) throw stripeError("StripeInvalidRequestError", "No such checkout session");
      return { ...s };
    },
    async expireCheckoutSession(sid) {
      count("expireCheckoutSession");
      const s = sessions.get(sid);
      if (!s) throw stripeError("StripeInvalidRequestError", "No such checkout session");
      if (s.status !== "open") throw stripeError("StripeInvalidRequestError", "Only open sessions can be expired");
      s.status = "expired";
      return { ...s };
    },
    async retrieveSubscription(subId) {
      count("retrieveSubscription");
      if (failure("retrieveSubscription") === "outage") throw stripeError("StripeConnectionError", "connection timeout");
      const s = subs.get(subId);
      if (!s) throw stripeError("StripeInvalidRequestError", "No such subscription");
      return JSON.parse(JSON.stringify(s));
    },
    async listSubscriptions(customer) {
      count("listSubscriptions");
      return [...subs.values()].filter((s) => s.customer === customer).map((s) => JSON.parse(JSON.stringify(s)));
    },
    async createPortalSession(params) {
      count("createPortalSession");
      portalCalls.push({ customer: params.customer, return_url: params.return_url });
      return { url: `https://billing.stripe.test/p/${params.customer}` };
    },
    constructEvent(rawBody, signature, secret) {
      return verifyStripeSignature(rawBody, signature, secret);
    },
  };

  /** The customer pays: the session completes and an active subscription exists (as Stripe would do). */
  function completeCheckout(sessionId: string, status = "active", periodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400) {
    const s = sessions.get(sessionId)!;
    const sub: StripeSubscriptionLite = {
      id: id("sub"),
      customer: s.customer!,
      status,
      livemode,
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      metadata: { ...s.subscriptionMetadata },
      items: { data: [{ price: { id: s.price }, current_period_end: periodEnd }] },
    };
    subs.set(sub.id, sub);
    s.status = "complete";
    s.subscription = sub.id;
    return sub;
  }
  function updateSubscription(subId: string, patch: Partial<StripeSubscriptionLite>) {
    Object.assign(subs.get(subId)!, patch);
    return subs.get(subId)!;
  }
  /** A subscription created directly in Stripe (e.g. via the Dashboard), for mapping / exception tests. */
  function addSubscription(sub: Omit<StripeSubscriptionLite, "livemode"> & { livemode?: boolean }) {
    subs.set(sub.id, { livemode, ...sub });
    return subs.get(sub.id)!;
  }

  return { api, customers, sessions, subs, calls, portalCalls, failNext, completeCheckout, updateSubscription, addSubscription };
}
export type FakeStripe = ReturnType<typeof createFakeStripe>;
