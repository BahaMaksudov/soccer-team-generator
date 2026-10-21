import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/pricing", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import PricingPage, { generateMetadata } from "@/app/pricing/page";
import PlanComparison from "@/components/billing/PlanComparison";
import { BILLING_NOT_ACTIVE_NOTE, billingConfig, PRO_PRICES_USD } from "@/lib/billing/config";

/**
 * Visible product branding is "TeamBalance Pro" everywhere; the pricing page
 * never suggests anyone is (or will automatically be) charged while paid billing
 * is not active.
 */
const ROOT = path.join(process.cwd(), "src");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
/** Not product branding shown to users: the AI recap's internal prompt and Stripe's appInfo (third-party config). */
const ALLOWED = ["src/lib/recap.ts", "src/lib/billing/stripe.ts"];

describe("brand: TeamBalance Pro", () => {
  it("no visible 'Team Balance Pro' (or split 'Team Balance <Pro>' wordmark) outside comments, tests and the documented exceptions", () => {
    const offenders: string[] = [];
    for (const f of walk(ROOT)) {
      const rel = path.relative(process.cwd(), f);
      if (!/\.(tsx?|css)$/.test(f) || /__tests__|\.test\.tsx?$|\.itest\.ts$/.test(f) || ALLOWED.includes(rel)) continue;
      fs.readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
          if (/Team Balance Pro|Team Balance <span/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("pricing while paid billing is not active (Production today)", () => {
  it("billing is off in the test environment (BILLING_ENABLED unset)", () => {
    expect(billingConfig().enabled).toBe(false);
  });
  it("the page labels Pro prices as planned and says nobody is charged — no auto-renewal wording", () => {
    const html = renderToStaticMarkup(createElement(PricingPage));
    expect(html).toContain(`Planned: ${PRO_PRICES_USD.month}/month or ${PRO_PRICES_USD.year}/year`);
    expect(html).toContain(BILLING_NOT_ACTIVE_NOTE.replace(/'/g, "&#x27;"));
    expect(html).not.toMatch(/renews automatically|auto-?renew|will be charged/i);
    expect(String(generateMetadata().description)).toContain("Paid Pro plans are planned");
  });
  it("the comparison shows the plain price only when billing is live", () => {
    expect(renderToStaticMarkup(createElement(PlanComparison, { planned: false }))).not.toContain("Planned:");
    expect(renderToStaticMarkup(createElement(PlanComparison, { planned: true }))).toContain("Planned:");
  });
});
