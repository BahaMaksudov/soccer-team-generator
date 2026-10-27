import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/local", () => ({ default: (o: { variable: string }) => ({ variable: o.variable }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/settings", () => ({ getTeamName: vi.fn(async () => "TeamBalance Pro") }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import PricingPlans, { planFeatures, PRICING_FOOTNOTE, YEARLY_SAVINGS_CENTS, YEARLY_SAVINGS_TEXT } from "@/components/billing/PricingPlans";
import { BrandLogo, BrandMark } from "@/components/brand/BrandLogo";
import BillingActions from "@/app/admin/o/[organizationSlug]/billing/BillingActions";
import { PLAN_LIMITS } from "@/lib/entitlements";
import { PRO_PRICES_USD } from "@/lib/billing/config";
import { LIVE_PRICE_EXPECTATIONS } from "@/lib/billing/prices";
import { metadata } from "@/app/layout";
import manifest from "@/app/manifest";

/** Landing-page pricing cards and brand assets (offline). */
const root = process.cwd();
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/<[^>]+>/g, "").trim() }));
const pngSize = (rel: string) => {
  const b = fs.readFileSync(path.join(root, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe("pricing cards come from the enforced catalog", () => {
  it("Free: exactly the requested lines, from PLAN_LIMITS.FREE", () => {
    expect(planFeatures(PLAN_LIMITS.FREE, { upTo: false })).toEqual([
      { text: "1 group", included: true },
      { text: "Up to 30 players per organization, across all groups", included: true },
      { text: "4 matches per month", included: true },
      { text: "1 recurring schedule", included: true },
      { text: "2 AI recaps per month", included: true },
      { text: "Unlimited balanced team generation", included: true },
      { text: "Telegram integration not included", included: false },
    ]);
  });
  it("Pro (monthly and yearly — identical entitlements): exactly the requested lines, from PLAN_LIMITS.PRO", () => {
    expect(planFeatures(PLAN_LIMITS.PRO, { upTo: true })).toEqual([
      { text: "Up to 3 groups", included: true },
      { text: "Up to 150 players per organization, across all groups", included: true },
      { text: "Unlimited matches", included: true },
      { text: "Unlimited recurring schedules", included: true },
      { text: "30 AI recaps per month", included: true },
      { text: "Unlimited balanced team generation", included: true },
      { text: "Telegram integration included", included: true },
    ]);
  });
  it("prices and the annual saving match the amounts the Stripe Price check enforces", () => {
    expect(PRO_PRICES_USD).toEqual({ month: "$9.99", year: "$99" });
    expect(LIVE_PRICE_EXPECTATIONS.month.unit_amount).toBe(999);
    expect(LIVE_PRICE_EXPECTATIONS.year.unit_amount).toBe(9900);
    expect(YEARLY_SAVINGS_CENTS).toBe(2088); // 12 × $9.99 − $99
    expect(YEARLY_SAVINGS_TEXT).toBe("Save $20.88 per year compared with monthly billing.");
  });
});

describe("pricing section (billing live)", () => {
  const html = renderToStaticMarkup(createElement(PricingPlans, { live: true }));
  const text = visible(html);
  it("heading, three cards, prices, saving, footnote", () => {
    expect(text).toContain("Simple pricing for every team");
    expect(text).toContain("Start free. Upgrade when your team needs more.");
    expect(html.match(/<article/g)).toHaveLength(3);
    for (const s of ["Free", "$0", "forever", "Pro Monthly", "$9.99", "/month", "Pro Yearly", "$99", "/year", "Includes all Pro features with annual billing.", YEARLY_SAVINGS_TEXT]) expect(text, s).toContain(s);
    expect(text).toContain(PRICING_FOOTNOTE);
    expect(text).toContain("Both Pro plans include the same features; only the billing period and price differ.");
    expect(html.match(/Recommended/g)).toHaveLength(1);
    expect(html).toContain('id="pricing"');
  });
  it("CTAs use the existing flows: Free → sign-up; Pro → /upgrade hand-off (never Stripe directly)", () => {
    const ctas = links(html).filter((l) => /^Get /.test(l.text));
    expect(ctas).toEqual([
      { href: "/signup", text: "Get Started Free" },
      { href: "/upgrade?plan=month", text: "Get Pro Monthly" },
      { href: "/upgrade?plan=year", text: "Get Pro Yearly" },
    ]);
    expect(html).not.toMatch(/stripe\.com|checkout\.stripe|sk_live|pk_live|price_/i);
  });
  it("the yearly card shows the same feature list as monthly (no extra benefits)", () => {
    const lists = [...html.matchAll(/<ul[\s\S]*?<\/ul>/g)].map((m) => visible(m[0]).trim());
    expect(lists).toHaveLength(3);
    expect(lists[1]).toBe(lists[2]);
  });
});

describe("pricing section (billing off)", () => {
  const html = renderToStaticMarkup(createElement(PricingPlans, { live: false }));
  it("Pro is shown as planned; no purchase links and no renewal wording", () => {
    expect(html).not.toContain("/upgrade");
    expect(html.match(/Coming soon/g)).toHaveLength(2);
    expect(html).toContain("Planned price — not available yet");
    expect(visible(html)).not.toMatch(/renews? automatically|renew automatically/i);
    expect(links(html).filter((l) => l.text === "Get Started Free")).toEqual([{ href: "/signup", text: "Get Started Free" }]);
  });
});

describe("brand assets", () => {
  it("header logo: the supplied horizontal logo, only its empty transparent margin trimmed; aspect ratio kept; legible size", () => {
    expect(pngSize("public/branding/TeamBalanceProHeaderLogo.png")).toEqual({ w: 2089, h: 511 });
    expect(pngSize("public/branding/TeamBalance Pro Fitness Logo.png")).toEqual({ w: 2172, h: 724 }); // original kept
    expect(pngSize("public/branding/TeamBalanceProMainLogo.png")).toEqual({ w: 1983, h: 793 }); // promotional banner kept
    expect(pngSize("public/branding/teambalancefavicon.png")).toEqual({ w: 1254, h: 1254 });
    const img = renderToStaticMarkup(createElement(BrandLogo));
    expect(img).toContain('alt="TeamBalance Pro"');
    expect(img).toContain("TeamBalanceProHeaderLogo");
    expect(img).not.toContain("TeamBalanceProMainLogo");
    expect(img).toContain('width="2089"');
    expect(img).toContain('height="511"');
    expect(img).toMatch(/class="[^"]*h-9 w-auto sm:h-10/); // 36–40 px tall → ~147–164 px wide; lettering legible
    expect(img).not.toMatch(/^<span/); // light surfaces: no backing
    const dark = renderToStaticMarkup(createElement(BrandLogo, { onDark: true }));
    expect(dark).toMatch(/^<span class="[^"]*bg-white/); // dark lettering stays legible on dark surfaces
    expect(renderToStaticMarkup(createElement(BrandMark))).toContain('alt=""'); // decorative next to a labelled link
  });
  it("Billing form preselects the interval chosen on the pricing page (?plan=)", () => {
    const props = { organizationSlug: "club", canPurchase: true, canManage: false, prices: { month: "$9.99", year: "$99" }, chargeNotices: { month: "m-notice", year: "y-notice" }, termsHref: "/terms" };
    const checkedRadio = (html: string) => (html.match(/<input type="radio"[^>]*>/g) ?? []).filter((t) => t.includes('checked=""')).map((t) => t.match(/value="(\w+)"/)?.[1]);
    const year = renderToStaticMarkup(createElement(BillingActions, { ...props, initialInterval: "year" }));
    expect(checkedRadio(year)).toEqual(["year"]);
    expect(year).toContain("y-notice");
    const month = renderToStaticMarkup(createElement(BillingActions, props));
    expect(checkedRadio(month)).toEqual(["month"]); // default
    expect(month).toMatch(/<input[^>]*type="checkbox"[^>]*required=""/); // Terms agreement still required
  });
  it("onboarding continues to /upgrade with the plan and the new organization (validated there), else the group page", () => {
    const src = fs.readFileSync(path.join(root, "src/app/onboarding/OnboardingClient.tsx"), "utf8");
    expect(src).toContain("plan && slug ? `/upgrade?plan=${plan}&org=${encodeURIComponent(slug)}` : data.href");
    const page = fs.readFileSync(path.join(root, "src/app/onboarding/page.tsx"), "utf8");
    expect(page).toContain('rawPlan === "month" || rawPlan === "year" ? rawPlan : null'); // only two values pass through
  });
  it("favicon set: generated sizes exist at the declared dimensions; metadata and manifest point at them", () => {
    for (const [f, s] of [["public/icons/favicon-16x16.png", 16], ["public/icons/favicon-32x32.png", 32], ["public/icons/favicon-48x48.png", 48], ["public/icons/apple-touch-icon.png", 180], ["public/icons/icon-192.png", 192], ["public/icons/icon-512.png", 512]] as const) {
      expect(pngSize(f), f).toEqual({ w: s, h: s });
    }
    const ico = fs.readFileSync(path.join(root, "public/favicon.ico"));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]); // ICO header
    const icons = metadata.icons as { icon: Array<{ url: string }>; apple: Array<{ url: string }> };
    for (const { url } of [...icons.icon, ...icons.apple]) expect(fs.existsSync(path.join(root, "public", url)), url).toBe(true);
    expect(icons.apple).toEqual([{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]);
    const m = manifest();
    expect(m.icons?.map((i) => i.src)).toEqual(["/icons/icon-192.png", "/icons/icon-512.png"]);
    for (const i of m.icons ?? []) expect(fs.existsSync(path.join(root, "public", i.src))).toBe(true);
  });
  it("the shared logo replaces the old marks in every header (no duplicated product-name text next to it)", () => {
    const parts = fs.readFileSync(path.join(root, "src/components/marketing/parts.tsx"), "utf8");
    const shell = fs.readFileSync(path.join(root, "src/components/app-shell/AppShell.tsx"), "utf8");
    const site = fs.readFileSync(path.join(root, "src/components/SiteHeader.tsx"), "utf8");
    expect(parts).toContain("<BrandLogo");
    expect(parts).not.toMatch(/TeamBalance <span/);
    expect(shell).toContain("<BrandLogo");
    expect(shell).toContain("<BrandMark"); // compact mark in the narrow mobile header
    expect(shell).not.toMatch(/TeamBalance <span/);
    expect(site).toContain("<BrandLogo");
    expect(site).not.toMatch(/<div className="text-xs text-white\/70">TeamBalance Pro<\/div>/);
  });
});
