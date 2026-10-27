import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
import { OWNER_ITEMS, legalIsDraft, LEGAL_PATHS, legalCanonical, LEGAL_EFFECTIVE_DATE, LEGAL_CONTACT_EMAIL, OPERATING_BRAND, PRODUCT_NAME, formatEffectiveDate, isIsoDate } from "@/lib/legal";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { REDESIGNED_PATHS, isPublicRedesignedPath } from "@/lib/chrome";
import { config } from "@/middleware";
import { PRIVATE_PREFIXES } from "@/app/robots";

/**
 * Public legal pages: reachable without signing in (Google's OAuth review needs
 * them), linked from the public pages, honest about open owner decisions, and
 * consistent with the Google scopes the app actually requests.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const privacy = read("src/app/privacy/page.tsx");
const terms = read("src/app/terms/page.tsx");
// Markers placed in the pages (the layout's effective-date marker is only a fallback for an unset date).
const used = [...`${privacy}${terms}`.matchAll(/<OwnerTodo id="([a-z-]+)"/g)].map((m) => m[1]);

describe("legal pages — public and linked", () => {
  it("/privacy and /terms are never auth-gated, tagged as redesigned pages and not disallowed for crawlers", () => {
    for (const p of [LEGAL_PATHS.privacy, LEGAL_PATHS.terms]) {
      expect(REDESIGNED_PATHS).toContain(p);
      expect(isPublicRedesignedPath(p)).toBe(true);
      expect(config.matcher).toContain(p);
      expect(PRIVATE_PREFIXES.some((x) => p.startsWith(x))).toBe(false);
    }
    expect(read("next.config.js")).not.toMatch(/"\/(privacy|terms)"/);
  });
  it("linked from the homepage footer, the auth pages (incl. sign-up), the sign-up form, pricing and player pages", () => {
    for (const f of ["src/app/page.tsx", "src/components/auth/AuthLayout.tsx", "src/app/signup/SignupClient.tsx", "src/app/pricing/page.tsx", "src/components/match-link/MatchView.tsx"]) {
      const s = read(f);
      expect(s, f).toContain('"/privacy"');
      expect(s, f).toContain('"/terms"');
    }
    expect(read("src/app/signup/SignupClient.tsx")).toContain("By creating an account, you agree to our");
  });
});

describe("legal pages — no invented facts", () => {
  it("open items, by category (mailbox confirmed; hosting locations verified)", () => {
    const by = (c: string) => OWNER_ITEMS.filter((i) => i.category === c).map((i) => i.id);
    expect(by("publication")).toEqual([]);
    expect(by("legal-review")).toEqual([]);
    expect(by("billing-launch")).toEqual([]); // 2026-10-27: paid subscription terms published
    expect(`${privacy}${terms}`).not.toMatch(/id="(mailbox|hosting-disclosure|operator-identity|mailing-address)"/);
  });
  it("every publication / legal-review item is shown on a page; billing-launch items are not rendered as markers", () => {
    const shown = OWNER_ITEMS.filter((i) => i.category !== "billing-launch").map((i) => i.id);
    for (const u of used) expect(shown).toContain(u);
    for (const id of shown) expect(used, id).toContain(id);
    expect(used).not.toContain("billing-terms");
  });
  it("while any item is open OR the publication date is unset: draft banner + noindex (never presented as a final policy)", () => {
    // Published 2026-10-21, paid terms added 2026-10-27 (owner-approved releases): nothing open, explicit date set.
    expect(legalIsDraft()).toBe(false);
    expect(LEGAL_EFFECTIVE_DATE).toBe("2026-10-27");
    expect(legalIsDraft([], null)).toBe(true);
    expect(legalIsDraft([], "2026-13-40")).toBe(true);
    expect(legalIsDraft([{ id: "x", label: "x", category: "publication" }], "2026-12-01")).toBe(true);
    expect(legalIsDraft([{ id: "x", label: "x", category: "legal-review" }], "2026-12-01")).toBe(true);
    // Billing-launch items don't block publishing the legal pages (they gate paid billing).
    expect(legalIsDraft([{ id: "x", label: "x", category: "billing-launch" }], "2026-12-01")).toBe(false);
    expect(legalIsDraft([], "2026-12-01")).toBe(false);
    expect(isIsoDate("2026-12-01")).toBe(true);
    expect(formatEffectiveDate("2026-12-01")).toBe("December 1, 2026");
    expect(read("src/components/legal/LegalPage.tsx")).toContain("Draft for owner review — not yet a final policy.");
    for (const s of [privacy, terms]) expect(s).toContain("...(legalIsDraft() ? { robots: { index: false, follow: true } } : {})");
  });
  it("no claims about analytics/trackers the app does not have", () => {
    const pkg = read("package.json");
    for (const t of ["@vercel/analytics", "posthog", "gtag", "@sentry"]) expect(pkg).not.toContain(t);
    expect(privacy).toContain("We do not use analytics, advertising or tracking cookies");
  });
  it("trial length and Pro prices come from the enforced catalog (not hard-coded text)", () => {
    expect(terms).toContain("{TRIAL_DAYS}-day Pro trial");
    expect(terms).toContain("{PRO_PRICES_USD.month}");
    expect(terms).toContain("const free = PLAN_LIMITS.FREE;");
  });
});

describe("canonical URLs", () => {
  it("absolute on APP_BASE_URL; the bare path when it isn't a valid origin", () => {
    expect(legalCanonical("/privacy", { APP_BASE_URL: "https://teambalancepro.com" })).toBe("https://teambalancepro.com/privacy");
    expect(legalCanonical("/terms", { APP_BASE_URL: "https://teambalancepro.com/" })).toBe("https://teambalancepro.com/terms");
    expect(legalCanonical("/terms", {})).toBe("/terms");
    expect(legalCanonical("/terms", { APP_BASE_URL: "javascript:alert(1)" })).toBe("/terms");
  });
});

describe("Google Sign-In disclosure matches the scopes requested", () => {
  it("the Google provider uses next-auth's default scope (openid email profile) — nothing added", () => {
    expect(read("src/lib/authOptions.ts")).toMatch(/GoogleProvider\(\{ clientId: google\.clientId, clientSecret: google\.clientSecret \}\)/);
    expect(read("node_modules/next-auth/providers/google.js")).toContain('scope: "openid email profile"');
    expect(privacy).toContain("<code>openid</code>, <code>email</code> and <code>profile</code>");
  });
});

describe("legal pages — rendered content (owner decisions applied, no false claims)", () => {
  const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1");
  const pages = { privacy: text(createElement(PrivacyPage)), terms: text(createElement(TermsPage)) };

  it("brand, operator structure and contact on both pages; no entity or address claims", () => {
    for (const [name, t] of Object.entries(pages)) {
      expect(t, name).toContain(`${PRODUCT_NAME} is operated by an individual under the ${OPERATING_BRAND} brand`);
      expect(t, name).toContain(`${OPERATING_BRAND} is a brand name, not a registered company`);
      expect(t, name).toContain(LEGAL_CONTACT_EMAIL);
      expect(t, name).not.toMatch(/\bLLC\b|\bInc\.?\b|\bCorp(oration)?\b|\bLtd\b|incorporated|registered trademark/i);
      expect(t, name).not.toMatch(/\d+\s+\w+\s+(Street|St\.|Avenue|Ave\.|Road|Rd\.|Suite|Blvd)|P\.?O\.? Box/i);
      expect(t, name).not.toContain("Draft for owner review");
      expect(t, name).not.toContain("Owner to confirm");
      expect(t, name).toContain("Effective date: October 27, 2026");
    }
  });
  it("adult-only accounts vs organizer-managed youth profiles; no claimed age or consent verification", () => {
    expect(pages.privacy).toContain("accounts are only for adults aged 18 or older. The service does not verify ages.");
    expect(pages.privacy).toContain("the service does not verify parental consent");
    expect(pages.terms).toContain("You must be at least 18 years old");
    expect(pages.terms).toContain("We do not verify ages or parental permission");
    expect(`${pages.privacy}${pages.terms}`).not.toMatch(/we verify (your )?age|age verification is|parental consent is verified|COPPA[- ]compliant/i);
  });
  it("paid subscription terms are published: price, renewal, cancellation, refunds, tax; no over-promises", () => {
    expect(pages.terms).not.toContain("not available yet");
    expect(pages.privacy).not.toContain("Paid billing is not active");
    expect(pages.terms).toContain("Pro costs $9.99 per month or $99 per year, in US dollars, billed in advance");
    expect(pages.terms).toContain("your subscription renews automatically at the end of each monthly or annual billing period");
    expect(pages.terms).toContain("Cancellation takes effect at the end of the current paid billing period.");
    expect(pages.terms).toContain("subscription payments are generally non-refundable");
    expect(pages.terms).toContain("so the tax may be $0. Any tax is shown at checkout and on each invoice before you pay.");
    expect(pages.privacy).toContain("Billing information (organization owners who subscribe to Pro)");
    for (const t of Object.values(pages)) expect(t).not.toMatch(/full refund|money-back|refunds? (are|is) guaranteed|attorney[- ]reviewed|reviewed by (an )?attorney|in every state/i);
  });
  it("deletion is manual: no self-service, no deadlines, no immediate or backup deletion guarantees", () => {
    expect(pages.privacy).toContain("There is no self-service account deletion");
    expect(pages.privacy).toContain("Requests are handled manually");
    for (const t of Object.values(pages)) expect(t).not.toMatch(/within \d+ (business )?days|immediately (delete|remove|erase)|deleted immediately|permanently deleted from (all )?backups|automatically deleted after \d+ (days|months|years)/i);
  });
  it("governing law is Massachusetts; no venue, arbitration or class-action provisions", () => {
    expect(pages.terms).toContain("governed by the laws of the Commonwealth of Massachusetts, United States");
    expect(pages.terms).not.toMatch(/arbitration|class action|class-action|exclusive (jurisdiction|venue)|jury trial/i);
  });
  it("verified hosting locations are stated; other providers described generically", () => {
    expect(pages.privacy).toContain("the application runs on Vercel in its iad1 (Washington, D.C., United States) region");
    expect(pages.privacy).toContain("Neon on Amazon Web Services, US East (N. Virginia, us-east-1)");
    expect(pages.privacy).toContain("may process information in the United States or other countries");
  });
  it("youth exposure is disclosed explicitly for Public, link-shared and Telegram visibility; no youth protections claimed", () => {
    expect(pages.privacy).toContain("Youth player profiles are handled exactly like other player profiles — there are no separate youth protections.");
    expect(pages.privacy).toContain("in a Public group, anyone with the group's address can see the roster with each youth player's first and last name and position");
    expect(pages.privacy).toContain("anyone holding a group share link or match link can see their names in published teams");
    expect(pages.privacy).toContain("who voted how in the non-anonymous polls");
    expect(pages.terms).toContain("including for showing youth players' names through Public or link-shared group pages and connected Telegram groups");
    expect(pages.privacy).toContain("shows the roster (first and last names, positions and whether each player is active)");
    expect(pages.privacy).toContain("polls are not anonymous");
    expect(pages.privacy).toContain("anyone who has a link can open it and pass it on");
  });
  it("not presented as attorney-approved", () => {
    for (const t of Object.values(pages)) expect(t).not.toMatch(/attorney[- ]approved|reviewed by (our )?(counsel|attorneys?|lawyers?)/i);
  });
});
