import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// Render the pages as they will look AFTER the separately approved publication (no billing-launch item pending).
vi.mock("@/lib/legal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legal")>();
  return { ...actual, billingTermsPublished: () => true };
});

import { checkoutRequestHash, parseUsBillingAddress, US_ONLY_MESSAGE, US_STATES } from "@/lib/billing/address";
import { checkPrice, taxExclusive } from "@/lib/billing/prices";
import { chargeNotice } from "@/lib/billing/checkout";
import { billingTermsPublished, OWNER_ITEMS, LEGAL_CONTACT_EMAIL } from "@/lib/legal";
import type { StripePriceLite } from "@/lib/billing/stripe";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

/** M11.2C — launch safeguards (offline): US-only address, tax behavior, disclosures, published-terms text, deletion guard SQL. */
const US = { line1: "1 Main St", line2: "", city: "Boston", state: "MA", postal_code: "02108", country: "US" };
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("US-only billing address (server-side)", () => {
  it("accepts a US address (50 states + DC) and normalizes it", () => {
    expect(US_STATES).toHaveLength(51);
    expect(parseUsBillingAddress({ ...US, state: "ma", line1: "  1   Main St " })).toEqual({ ok: true, address: { line1: "1 Main St", line2: null, city: "Boston", state: "MA", postal_code: "02108", country: "US" } });
    expect(parseUsBillingAddress({ ...US, postal_code: "02108-1234", country: undefined }).ok).toBe(true); // country defaults to US
  });
  it("refuses any other country — whatever the rest of the address says", () => {
    for (const country of ["CA", "GB", "MX", "PR", "USA", "United States", "us-x"]) {
      expect(parseUsBillingAddress({ ...US, country }), country).toEqual({ ok: false, error: US_ONLY_MESSAGE, field: "country" });
    }
  });
  it("refuses non-US states / territories, bad ZIPs and missing fields", () => {
    for (const state of ["ON", "PR", "GU", "VI", "XX", ""]) expect(parseUsBillingAddress({ ...US, state }), state).toMatchObject({ ok: false, field: "state" });
    for (const postal_code of ["2108", "ABCDE", "02108-12", "K1A 0B1", ""]) expect(parseUsBillingAddress({ ...US, postal_code }), postal_code).toMatchObject({ ok: false, field: "postal_code" });
    expect(parseUsBillingAddress({ ...US, line1: " " })).toMatchObject({ ok: false, field: "line1" });
    expect(parseUsBillingAddress({ ...US, city: "" })).toMatchObject({ ok: false, field: "city" });
    expect(parseUsBillingAddress({ ...US, line1: "x".repeat(101) })).toMatchObject({ ok: false, field: "line1" });
    expect(parseUsBillingAddress(null)).toMatchObject({ ok: false });
  });
  it("request fingerprint: stable, changes with interval / address / terms version, reveals nothing", () => {
    const a = parseUsBillingAddress(US);
    if (!a.ok) throw new Error("expected ok");
    const h = checkoutRequestHash("month", a.address, "2026-11-01");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(checkoutRequestHash("month", a.address, "2026-11-01")).toBe(h);
    expect(checkoutRequestHash("year", a.address, "2026-11-01")).not.toBe(h);
    expect(checkoutRequestHash("month", { ...a.address, postal_code: "02109" }, "2026-11-01")).not.toBe(h);
    expect(checkoutRequestHash("month", a.address, "2026-12-01")).not.toBe(h);
    expect(h).not.toContain("Boston");
  });
});

describe("tax-exclusive Prices", () => {
  const price = (patch: Partial<StripePriceLite> = {}): StripePriceLite => ({ id: "price_m", livemode: true, active: true, type: "recurring", currency: "usd", unit_amount: 999, product: "prod", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, tax_behavior: "exclusive", ...patch });
  it("exclusive, or unspecified with an exclusive / USD-inferred default; never inclusive", () => {
    expect(taxExclusive("exclusive", null)).toBe(true);
    expect(taxExclusive("unspecified", "exclusive")).toBe(true);
    expect(taxExclusive("unspecified", "inferred_by_currency")).toBe(true);
    expect(taxExclusive("unspecified", "inclusive")).toBe(false);
    expect(taxExclusive("unspecified", null)).toBe(false);
    expect(taxExclusive("inclusive", "exclusive")).toBe(false);
    expect(checkPrice(price(), "month", true, "exclusive")).toBeNull();
    expect(checkPrice(price({ tax_behavior: "inclusive" }), "month", true, "exclusive")).toMatch(/taxes must be added on top/);
    expect(checkPrice(price({ tax_behavior: "unspecified" }), "month", true, null)).toMatch(/taxes must be added on top/);
  });
});

describe("recurring-charge disclosure at the decision point", () => {
  it("states price, tax, automatic renewal, cancellation, refund policy and trial effect", () => {
    expect(chargeNotice("month")).toBe(
      "You'll be charged $9.99 per month, plus applicable sales tax, starting today. Your subscription renews automatically every month at the then-current price until you cancel. Cancel any time in Manage billing; Pro stays until the end of the paid period. Payments are non-refundable except as described in our Terms. Any remaining free trial ends when you subscribe."
    );
    expect(chargeNotice("year")).toContain("$99 per year, plus applicable sales tax");
    expect(chargeNotice("year")).toContain("renews automatically every year");
    expect(chargeNotice("month").length).toBeLessThan(1200); // Stripe custom_text limit
  });
  it("the Billing page requires a Terms checkbox and US address before Checkout; prices show '+ tax'", () => {
    const ui = read("src/app/admin/o/[organizationSlug]/billing/BillingActions.tsx");
    expect(ui).toContain("disabled={busy || !accepted || !complete}");
    expect(ui).toContain("authorize this automatically renewing charge until I cancel");
    expect(ui).toContain("acceptTerms: accepted");
    expect(ui).toContain('country: "US"');
    expect(ui).toContain("+ tax");
    expect(read("src/app/pricing/page.tsx")).toContain("plus applicable sales tax");
  });
});

describe("published billing terms (rendered once the gate is lifted)", () => {
  const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1");
  const terms = text(createElement(TermsPage));
  const privacy = text(createElement(PrivacyPage));

  it("the gate itself is still in place in the code (this file mocks it open)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/legal")>("@/lib/legal");
    expect(OWNER_ITEMS.map((i) => i.id)).toContain("billing-terms");
    expect(actual.billingTermsPublished()).toBe(false);
    expect(billingTermsPublished()).toBe(true); // mocked
  });
  it("Terms §8: prices, US-only, renewal, cancellation at period end, no plan switching", () => {
    expect(terms).toContain("Pro costs $9.99 per month or $99 per year, in US dollars, billed in advance for the billing period you choose, plus applicable sales tax.");
    expect(terms).toContain("paid subscriptions are currently available only with a billing address in the United States");
    expect(terms).toContain("your subscription renews automatically at the end of each monthly or annual billing period");
    expect(terms).toContain("Cancellation takes effect at the end of the current paid billing period. Pro stays available until then and you won't be charged again.");
    expect(terms).toContain("Changing between monthly and annual billing is not currently offered.");
    expect(terms).not.toContain("not available yet");
  });
  it("Terms §8: the 10-point refund policy, exceptions by email, legally required refunds", () => {
    for (const s of [
      "subscription payments are generally non-refundable",
      "we do not give automatic refunds for unused subscription time, including after you cancel",
      "Cancelling a subscription and requesting a refund are separate",
      "there is no self-service refund option",
      "for example for a duplicate charge, an accidental plan selection, a significant service failure, or other goodwill reasons",
      `To request an exception, email ${LEGAL_CONTACT_EMAIL}`,
      "Each request is reviewed individually, and approval is not guaranteed.",
      "We will always honor refunds required by applicable law.",
    ])
      expect(terms, s).toContain(s);
  });
  it("Terms §8: 30-day price notice, sales tax from the billing address, discontinuation refund; no unconfigured reminder promise", () => {
    expect(terms).toContain("at least 30 days before a price increase applies to your subscription (or earlier where the law requires)");
    expect(terms).toContain("sales tax is calculated by our payment processor from your billing address and added at checkout and on each renewal");
    expect(terms).toContain("refund the unused part of any prepaid billing period");
    expect(terms).not.toMatch(/renewal reminder|remind you before/i);
  });
  it("Terms §10: deleting an account / organization does not cancel the subscription; deletion is refused while it is active", () => {
    expect(terms).toContain("Ending your account or deleting an organization does not cancel a Pro subscription by itself.");
    expect(terms).toContain("We do not delete an organization, or remove its last owner, until its subscription has ended.");
  });
  it("Privacy: billing information, address kept by Stripe, emails, Stripe as processor, retention, visibility", () => {
    expect(privacy).toContain("Billing information (organization owners who subscribe to Pro)");
    expect(privacy).toContain("It is sent to Stripe and kept by Stripe, where it is used to calculate sales tax");
    expect(privacy).toContain("We never receive full card numbers.");
    expect(privacy).toContain("payment receipts and other subscription emails sent by Stripe, and notice of price changes sent by us");
    expect(privacy).toContain("Stripe — processes Pro subscription payments and calculates sales tax.");
    expect(privacy).toContain("Billing records (subscription references, status and dates) are kept while the organization exists");
    expect(privacy).toContain("owners and admins can see its subscription status and billing dates");
    expect(privacy).not.toContain("Paid billing is not active");
  });
});

describe("deletion guard migration (static)", () => {
  const sql = read("prisma/migrations/20270110120000_m112c_launch_safeguards/migration.sql").replace(/--.*$/gm, "");
  it("additive: one nullable column, two functions, two triggers; no data change", () => {
    expect(sql).toContain('ALTER TABLE "BillingCheckoutSession" ADD COLUMN "requestHash" TEXT;');
    expect(sql).not.toMatch(/^\s*(DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b|ALTER COLUMN|SET NOT NULL/im);
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(sql).toContain("BEFORE DELETE ON \"Organization\"");
    expect(sql).toContain('BEFORE DELETE OR UPDATE OF "role", "organizationId" ON "OrganizationMembership"');
    expect(sql.match(/NOT IN \('canceled', 'incomplete_expired'\)/g)).toHaveLength(2); // scheduled-to-cancel (still active) blocks too
  });
});
