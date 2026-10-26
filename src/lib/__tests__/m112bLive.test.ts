import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkPrice, verifyConfiguredPrices, resetPriceCheckCacheForTests, LIVE_PRICE_EXPECTATIONS } from "@/lib/billing/prices";
import { billingConfig } from "@/lib/billing/config";
import type { BillingStripe, StripePriceLite } from "@/lib/billing/stripe";
import { isResourceMissing } from "@/lib/billing/stripe";

/** M11.2B — Live Price verification and the daily reconciliation workflow (offline). */
const price = (interval: "month" | "year", patch: Partial<StripePriceLite> = {}): StripePriceLite => ({
  id: `price_${interval}`,
  livemode: true,
  active: true,
  type: "recurring",
  currency: "usd",
  unit_amount: LIVE_PRICE_EXPECTATIONS[interval].unit_amount,
  product: "prod_pro",
  recurring: { interval, interval_count: 1, usage_type: "licensed" },
  tax_behavior: "exclusive",
  ...patch,
});

describe("Price verification", () => {
  it("live: exactly USD 9.99 / month and USD 99 / year, active, licensed, recurring, live-mode", () => {
    expect(LIVE_PRICE_EXPECTATIONS).toEqual({ month: { currency: "usd", unit_amount: 999 }, year: { currency: "usd", unit_amount: 9900 } });
    expect(checkPrice(price("month"), "month", true)).toBeNull();
    expect(checkPrice(price("year"), "year", true)).toBeNull();
    expect(checkPrice(price("month", { livemode: false }), "month", true)).toMatch(/not a live-mode Price/);
    expect(checkPrice(price("month"), "month", false)).toMatch(/not a test-mode Price/); // a live Price in a test deployment
    expect(checkPrice(price("month", { active: false }), "month", true)).toMatch(/inactive/);
    expect(checkPrice(price("month", { type: "one_time", recurring: null }), "month", true)).toMatch(/not recurring/);
    expect(checkPrice(price("year"), "month", true)).toMatch(/bills every 1 year/);
    expect(checkPrice(price("month", { unit_amount: 1000 }), "month", true)).toMatch(/expected 999 usd/);
    expect(checkPrice(price("month", { currency: "cad" }), "month", true)).toMatch(/expected 999 usd/);
  });
  it("test mode (Preview): mode / active / recurring / interval checked; amounts not pinned", () => {
    expect(checkPrice(price("month", { livemode: false, unit_amount: 500 }), "month", false)).toBeNull();
    expect(checkPrice(price("month", { livemode: false, active: false }), "month", false)).toMatch(/inactive/);
  });
  it("both Prices verified, one Product (live), failures fail closed, success cached", async () => {
    const config = billingConfig({ BILLING_ENABLED: "true", VERCEL_ENV: "production", BILLING_ALLOW_LIVE_MODE: "true", STRIPE_SECRET_KEY: "sk_live_" + "FAKE0000000000000000000000000000", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO_MONTHLY: "price_month", STRIPE_PRICE_PRO_ANNUAL: "price_year" }, []); // [] = billing terms published
    if (!config.enabled) throw new Error("expected enabled");
    let calls = 0;
    let year = price("year");
    let fail = false;
    const stripe = {
      async retrievePrice(id: string) {
        calls++;
        if (fail) throw Object.assign(new Error("down"), { type: "StripeConnectionError" });
        return id === "price_month" ? price("month") : year;
      },
    } as unknown as BillingStripe;
    resetPriceCheckCacheForTests();
    year = price("year", { product: "prod_other" });
    expect(await verifyConfiguredPrices(config, stripe)).toEqual({ ok: false, problem: "the two Prices belong to different Products" });
    fail = true;
    expect(await verifyConfiguredPrices(config, stripe)).toEqual({ ok: false, problem: "Price lookup failed (StripeConnectionError)" });
    fail = false;
    year = price("year");
    calls = 0;
    expect(await verifyConfiguredPrices(config, stripe, 1_000)).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(await verifyConfiguredPrices(config, stripe, 1_000 + 60_000)).toEqual({ ok: true });
    expect(calls).toBe(2); // cached
    expect(await verifyConfiguredPrices(config, stripe, 1_000 + 11 * 60_000)).toEqual({ ok: true });
    expect(calls).toBe(4); // re-verified after 10 minutes
  });
  it("resource_missing detection", () => {
    expect(isResourceMissing({ type: "StripeInvalidRequestError", code: "resource_missing" })).toBe(true);
    expect(isResourceMissing({ type: "StripeInvalidRequestError", statusCode: 404 })).toBe(true);
    expect(isResourceMissing({ type: "StripeConnectionError" })).toBe(false);
    expect(isResourceMissing(null)).toBe(false);
  });
});

const WORKFLOW = path.join(process.cwd(), ".github/workflows/billing-reconcile.yml");
const yml = fs.readFileSync(WORKFLOW, "utf8");
const code = yml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("daily billing reconciliation workflow", () => {
  it("is the only workflow calling the reconcile endpoint, and does not call match automation", () => {
    const dir = path.dirname(WORKFLOW);
    const callers = fs.readdirSync(dir).filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("/api/cron/billing-reconcile"));
    expect(callers).toEqual(["billing-reconcile.yml"]);
    expect(code).not.toContain("/api/cron/automation");
    expect(code).not.toMatch(/telegram/i);
  });
  it("runs once a day and on manual dispatch only; no inputs", () => {
    expect(code).toMatch(/^on:\n  schedule:\n    - cron: "41 6 \* \* \*".*\n  workflow_dispatch:\n\n/m);
    expect(code.match(/- cron:/g)).toHaveLength(1);
    expect(code).not.toMatch(/^\s*(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m);
    expect(code).not.toMatch(/workflow_dispatch:\n\s+inputs:/);
  });
  it("no duplicate runs: its own concurrency group, queued (never two at once), separate from match automation", () => {
    expect(code).toMatch(/concurrency:\n  group: tbp-billing-reconcile\n  cancel-in-progress: false/);
    expect(fs.readFileSync(path.join(path.dirname(WORKFLOW), "match-automation.yml"), "utf8")).toContain("group: tbp-match-automation");
    expect(code).not.toMatch(/--retry/); // one request per run
  });
  it("targets exactly the Production endpoint with POST, for main of this repository", () => {
    expect(code.match(/https?:\/\/[^\s"']+/g)).toEqual(["https://teambalancepro.com/api/cron/billing-reconcile"]);
    expect(code).not.toMatch(/localhost|vercel\.app|127\.0\.0\.1|github\.head_ref|github\.event\.inputs|inputs\./);
    expect(code).toContain("--request POST");
    expect(code).toContain("if: github.repository == 'BahaMaksudov/soccer-team-generator' && github.ref == 'refs/heads/main'");
    expect(code).toContain("permissions: {}");
  });
  it("reuses TBP_CRON_SECRET only, passed on stdin; nothing secret is printed", () => {
    expect(code.match(/secrets\.\w+/g)).toEqual(["secrets.TBP_CRON_SECRET"]);
    expect(code).toContain("printf 'header = \"Authorization: Bearer %s\"\\n' \"${TBP_CRON_SECRET}\" | curl \\\n            --config -");
    expect(code).not.toMatch(/Bearer [A-Za-z0-9_\-]{8,}/);
    expect(code).not.toMatch(/set -x|--verbose|\s-v\s|--trace|echo .*TBP_CRON_SECRET\}/);
    expect(code).not.toMatch(/-H\s|--header\s/);
  });
  it("billing off is a notice; any other non-OK answer fails the run; exceptions warn", () => {
    expect(code).toContain(`if [ "\${code}" = "503" ] && jq -e '.error == "Billing is not enabled."' response.json`);
    expect(code).toContain("::notice::Billing is not enabled in Production");
    expect(code).toContain(`if [ "\${code}" != "200" ] || ! jq -e '.ok == true' response.json`);
    expect(code).toMatch(/::error::Billing reconciliation failed[^\n]*\n\s+exit 1/);
    expect(code).toContain("::warning::Billing has open exceptions");
  });
  it("the endpoint's responses carry no personal data (counts / fixed messages only)", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/cron/billing-reconcile/route.ts"), "utf8");
    expect(route).toContain('{ ok: false, error: "Billing is not enabled." }, { status: 503 }');
    expect(route).toContain("{ ok: r.failures === 0, ...r }");
    expect(route).toContain('{ ok: false, error: "Reconciliation failed." }');
  });
});
