import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OWNER_ITEMS, legalIsDraft, LEGAL_PATHS, legalCanonical } from "@/lib/legal";
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
  it("every open owner decision is a known item and is shown on a page; nothing is silently dropped", () => {
    const ids = OWNER_ITEMS.map((i) => i.id);
    for (const u of used) expect(ids).toContain(u);
    for (const id of ids) expect(used, id).toContain(id);
  });
  it("while any item is open: draft banner + noindex (never presented as a final policy)", () => {
    expect(legalIsDraft()).toBe(OWNER_ITEMS.length > 0);
    expect(read("src/components/legal/LegalPage.tsx")).toContain("Draft for owner review — not yet a final policy.");
    for (const s of [privacy, terms]) expect(s).toContain("...(legalIsDraft() ? { robots: { index: false, follow: true } } : {})");
    expect(legalIsDraft([])).toBe(false);
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
