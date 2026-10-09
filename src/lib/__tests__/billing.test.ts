import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import { billingConfig, intervalForPrice, isLiveKey, LIVE_MODE_SUPPORTED, priceFor } from "@/lib/billing/config";
import { generateTestSignature, STRIPE_API_VERSION, toSubscriptionLite, verifyStripeSignature } from "@/lib/billing/stripe";
import { ENTITLING_STATUSES, LIVE_STATUSES, statusEntitlesPro } from "@/lib/billing/sync";

/** M11.2A — billing configuration guards, status mapping and signatures (offline). */
const OK = { BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc", STRIPE_PRICE_PRO_MONTHLY: "price_m", STRIPE_PRICE_PRO_ANNUAL: "price_y" };

describe("billing configuration", () => {
  it("off by default and whenever anything is missing", () => {
    expect(billingConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(billingConfig({ ...OK, BILLING_ENABLED: "TRUE" })).toEqual({ enabled: false, reason: "disabled" });
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL"]) expect(billingConfig({ ...OK, [k]: "" }), k).toEqual({ enabled: false, reason: "missing_configuration" });
    expect(billingConfig({ ...OK, STRIPE_PRICE_PRO_ANNUAL: "price_m" }).enabled).toBe(false); // same Price twice
    expect(billingConfig({ ...OK, STRIPE_WEBHOOK_SECRET: "not-a-secret" }).enabled).toBe(false);
  });
  it("test keys only in M11.2A: a live key is rejected even with BILLING_ALLOW_LIVE_MODE", () => {
    expect(LIVE_MODE_SUPPORTED).toBe(false);
    for (const key of ["sk_live_x", "rk_live_x"]) {
      expect(isLiveKey(key)).toBe(true);
      expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: key, BILLING_ALLOW_LIVE_MODE: "true" })).toEqual({ enabled: false, reason: "live_key_rejected" });
    }
    expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: "pk_test_x" }).enabled).toBe(false); // publishable key is not a secret key
    expect(billingConfig(OK)).toMatchObject({ enabled: true, livemode: false, prices: { month: "price_m", year: "price_y" } });
  });
  it("the Price allow-list maps only month/year", () => {
    const c = billingConfig(OK);
    if (!c.enabled) throw new Error("expected enabled");
    expect(priceFor(c, "month")).toBe("price_m");
    expect(priceFor(c, "year")).toBe("price_y");
    for (const bad of ["week", "price_m", null, undefined, 1, { interval: "month" }]) expect(priceFor(c, bad)).toBeNull();
    expect(intervalForPrice(c, "price_y")).toBe("year");
    expect(intervalForPrice(c, "price_other")).toBeNull();
  });
  it("production stays disabled by default: no billing variable is required by the app", () => {
    expect(fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8")).toMatch(/# BILLING_ENABLED="true"/); // documented commented-out
  });
});

describe("subscription status → entitlement", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["unpaid", false],
    ["canceled", false],
    ["incomplete", false],
    ["incomplete_expired", false],
    ["paused", false],
  ])("%s → Pro: %s", (status, pro) => expect(statusEntitlesPro(status)).toBe(pro));
  it("a live (not finished) subscription blocks a new Checkout", () => {
    expect([...LIVE_STATUSES].sort()).toEqual(["active", "incomplete", "past_due", "paused", "trialing", "unpaid"]);
    expect(ENTITLING_STATUSES).toEqual(["active", "trialing", "past_due"]);
  });
});

describe("Stripe SDK integration (offline)", () => {
  it("pins the SDK's API version", () => {
    expect(STRIPE_API_VERSION).toBe("2026-09-30.endive");
    expect(JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).dependencies.stripe).toBe("23.0.0");
  });
  it("webhook signatures: valid passes; tampered body, wrong secret and stale timestamps fail", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: {} } });
    expect(verifyStripeSignature(payload, generateTestSignature(payload, "whsec_a"), "whsec_a").id).toBe("evt_1");
    expect(() => verifyStripeSignature(payload.replace("evt_1", "evt_2"), generateTestSignature(payload, "whsec_a"), "whsec_a")).toThrow();
    expect(() => verifyStripeSignature(payload, generateTestSignature(payload, "whsec_b"), "whsec_a")).toThrow();
    expect(() => verifyStripeSignature(payload, generateTestSignature(payload, "whsec_a", Math.floor(Date.now() / 1000) - 3600), "whsec_a")).toThrow();
  });
  it("subscription mapping reads the period end from items (API 2026-09-30) and never card data", () => {
    const lite = toSubscriptionLite({
      id: "sub_1",
      customer: { id: "cus_1" },
      status: "active",
      livemode: false,
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      metadata: { organizationId: "org" },
      items: { data: [{ price: { id: "price_m" }, current_period_end: 1_900_000_000 }] },
      default_payment_method: { card: { last4: "4242" } },
    } as unknown as Stripe.Subscription);
    expect(lite).toEqual({ id: "sub_1", customer: "cus_1", status: "active", livemode: false, cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: { organizationId: "org" }, items: { data: [{ price: { id: "price_m" }, current_period_end: 1_900_000_000 }] } });
    expect(JSON.stringify(lite)).not.toContain("4242");
  });
  it("no card / payment-method fields exist in the billing schema", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const billing = schema.slice(schema.indexOf("model BillingSubscription"));
    expect(billing).not.toMatch(/last4|cardBrand|paymentMethod|cvc|expMonth/i);
  });
});
