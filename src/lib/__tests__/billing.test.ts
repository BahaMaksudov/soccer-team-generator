import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Stripe from "stripe";
import { billingConfig, billingConfig as realBillingConfig, billingTermsPending, intervalForPrice, isLiveKey, isWellFormedLiveKey, LIVE_MODE_SUPPORTED, priceFor, stripeModePermitted } from "@/lib/billing/config";
import { OWNER_ITEMS, type OwnerItem } from "@/lib/legal";
import { generateTestSignature, STRIPE_API_VERSION, toSubscriptionLite, verifyStripeSignature } from "@/lib/billing/stripe";
import { ENTITLING_STATUSES, LIVE_STATUSES, statusEntitlesPro } from "@/lib/billing/sync";

/** M11.2A — billing configuration guards, status mapping and signatures (offline). */
/** A syntactically valid, obviously fake live key (never a real credential). */
const FAKE_LIVE_SK = "sk_live_" + "FAKE0000000000000000000000000000";
const FAKE_LIVE_RK = "rk_live_" + "FAKE0000000000000000000000000000";
const OK = { BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc", STRIPE_PRICE_PRO_MONTHLY: "price_m", STRIPE_PRICE_PRO_ANNUAL: "price_y" };

describe("billing configuration", () => {
  it("off by default and whenever anything is missing", () => {
    expect(billingConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(billingConfig({ ...OK, BILLING_ENABLED: "TRUE" })).toEqual({ enabled: false, reason: "disabled" });
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL"]) expect(billingConfig({ ...OK, [k]: "" }), k).toEqual({ enabled: false, reason: "missing_configuration" });
    expect(billingConfig({ ...OK, STRIPE_PRICE_PRO_ANNUAL: "price_m" }).enabled).toBe(false); // same Price twice
    expect(billingConfig({ ...OK, STRIPE_WEBHOOK_SECRET: "not-a-secret" }).enabled).toBe(false);
  });
  it("M11.2B: outside Vercel Production a live key is rejected even with BILLING_ALLOW_LIVE_MODE", () => {
    expect(LIVE_MODE_SUPPORTED).toBe(true);
    for (const key of [FAKE_LIVE_SK, FAKE_LIVE_RK, "sk_live_x"]) {
      expect(isLiveKey(key)).toBe(true);
      for (const VERCEL_ENV of ["preview", "development", undefined, "", "Production", "prod"]) {
        expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: key, BILLING_ALLOW_LIVE_MODE: "true", VERCEL_ENV }), `${VERCEL_ENV}`).toEqual({ enabled: false, reason: "live_key_rejected" });
      }
    }
    expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: "pk_test_x" }).enabled).toBe(false); // publishable key is not a secret key
    expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: "pk_live_x", VERCEL_ENV: "production", BILLING_ALLOW_LIVE_MODE: "true" }).enabled).toBe(false);
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

describe("Production safety guard: no Stripe TEST mode in Vercel Production", () => {
  it("Preview and local development with a test key: enabled when configured", () => {
    for (const VERCEL_ENV of ["preview", "development", undefined, ""]) {
      expect(billingConfig({ ...OK, VERCEL_ENV }), String(VERCEL_ENV)).toMatchObject({ enabled: true, livemode: false });
    }
  });
  it("Production with a test key: blocked, even with BILLING_ENABLED=true (secret or restricted key)", () => {
    for (const key of ["sk_test_abc", "rk_test_abc"]) {
      expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: key, VERCEL_ENV: "production" })).toEqual({ enabled: false, reason: "test_key_in_production" });
      expect(billingConfig({ ...OK, STRIPE_SECRET_KEY: key, VERCEL_ENV: " production " })).toEqual({ enabled: false, reason: "test_key_in_production" });
    }
  });
  it("Production with billing disabled or unconfigured: disabled (no billing actions)", () => {
    expect(billingConfig({ VERCEL_ENV: "production" })).toEqual({ enabled: false, reason: "disabled" });
    expect(billingConfig({ ...OK, BILLING_ENABLED: "false", VERCEL_ENV: "production" })).toEqual({ enabled: false, reason: "disabled" });
    expect(billingConfig({ BILLING_ENABLED: "true", VERCEL_ENV: "production" })).toEqual({ enabled: false, reason: "missing_configuration" });
  });
  it("M11.2B: live mode in Production only with EVERY condition; any missing one disables billing", () => {
    const LIVE = { ...OK, STRIPE_SECRET_KEY: FAKE_LIVE_SK, BILLING_ALLOW_LIVE_MODE: "true", VERCEL_ENV: "production" };
    const billingConfig = (env: Record<string, string | undefined>, items: readonly OwnerItem[] = []) => realBillingConfig(env, items); // terms published unless a case says otherwise
    expect(billingConfig(LIVE)).toMatchObject({ enabled: true, livemode: true, prices: { month: "price_m", year: "price_y" } });
    expect(billingConfig({ ...LIVE, STRIPE_SECRET_KEY: FAKE_LIVE_RK })).toMatchObject({ enabled: true, livemode: true }); // restricted key
    expect(billingConfig({ ...LIVE, BILLING_ENABLED: "" })).toEqual({ enabled: false, reason: "disabled" });
    for (const v of ["", "false", "TRUE", "1", undefined]) expect(billingConfig({ ...LIVE, BILLING_ALLOW_LIVE_MODE: v }), String(v)).toEqual({ enabled: false, reason: "live_key_rejected" });
    for (const v of ["preview", "development", "", undefined]) expect(billingConfig({ ...LIVE, VERCEL_ENV: v }), String(v)).toEqual({ enabled: false, reason: "live_key_rejected" });
    for (const k of ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL"]) expect(billingConfig({ ...LIVE, [k]: "" }), k).toEqual({ enabled: false, reason: "missing_configuration" });
    expect(billingConfig({ ...LIVE, STRIPE_SECRET_KEY: "" })).toEqual({ enabled: false, reason: "missing_configuration" });
    expect(billingConfig({ ...LIVE, STRIPE_PRICE_PRO_ANNUAL: "price_m" }).enabled).toBe(false);
    // A truncated / placeholder live key is not a valid key.
    for (const key of ["sk_live_x", "sk_live_", "rk_live_short", `${FAKE_LIVE_SK} extra`, "sk_live_FAKE-000000000000000000000000000"]) {
      expect(isWellFormedLiveKey(key), key).toBe(false);
      expect(billingConfig({ ...LIVE, STRIPE_SECRET_KEY: key }).enabled, key).toBe(false);
    }
    // Live charges wait for the published billing / cancellation / refund terms (legal.ts billing-launch item).
    const pending = [{ id: "billing-terms", category: "billing-launch" as const, label: "x" }];
    expect(billingConfig(LIVE, pending)).toEqual({ enabled: false, reason: "billing_terms_pending" });
    expect(billingConfig({ ...OK, VERCEL_ENV: "preview" }, pending)).toMatchObject({ enabled: true, livemode: false }); // test mode unaffected
    expect(billingTermsPending()).toBe(OWNER_ITEMS.some((i) => i.category === "billing-launch"));
    expect(realBillingConfig(LIVE).enabled).toBe(!billingTermsPending()); // as committed: off until the terms are published
    // A test key is still refused in Production, even with the live flag.
    expect(billingConfig({ ...LIVE, STRIPE_SECRET_KEY: "sk_test_abc" })).toEqual({ enabled: false, reason: "test_key_in_production" });
  });
  it("stripeModePermitted: test only outside Production; live only in Production with BILLING_ALLOW_LIVE_MODE=true", () => {
    expect(stripeModePermitted(false, {})).toBe(true);
    expect(stripeModePermitted(false, { VERCEL_ENV: "preview" })).toBe(true);
    expect(stripeModePermitted(false, { VERCEL_ENV: "production" })).toBe(false);
    expect(stripeModePermitted(false, { VERCEL_ENV: "production", BILLING_ALLOW_LIVE_MODE: "true" })).toBe(false);
    expect(stripeModePermitted(true, { VERCEL_ENV: "production", BILLING_ALLOW_LIVE_MODE: "true" })).toBe(true);
    expect(stripeModePermitted(true, { VERCEL_ENV: "production" })).toBe(false);
    for (const VERCEL_ENV of ["preview", "development", undefined]) expect(stripeModePermitted(true, { VERCEL_ENV, BILLING_ALLOW_LIVE_MODE: "true" })).toBe(false);
  });
  it("one shared gate: every billing path reads billingConfig(); no other code reads the Stripe key", () => {
    const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
    expect(read("src/lib/billing/checkout.ts").match(/billingConfig\(\)/g)?.length).toBeGreaterThanOrEqual(3); // checkout, portal, view
    expect(read("src/lib/billing/webhook.ts")).toMatch(/const config = billingConfig\(\);\s*if \(!config\.enabled\) return \{ status: 503/);
    expect(read("src/lib/billing/sync.ts")).toMatch(/const config = billingConfig\(\);\s*if \(!config\.enabled\) throw/);
    expect(read("src/app/api/cron/billing-reconcile/route.ts")).toContain("if (!billingConfig().enabled)");
    expect(read("src/lib/billing/stripe.ts")).toMatch(/const config = billingConfig\(\);\s*if \(!config\.enabled\) throw/);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|itest)\.ts$/.test(e.name) && rel !== path.join("src", "lib", "billing", "config.ts") && /env\.STRIPE_SECRET_KEY|process\.env\.STRIPE_SECRET_KEY/.test(read(rel))) offenders.push(rel);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
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
