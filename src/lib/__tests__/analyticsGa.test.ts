import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import {
  analyticsAllowed,
  analyticsPageTitle,
  ANALYTICS_ROUTES,
  CONSENT_STORAGE_KEY,
  gaCookieNames,
  isAnalyticsRoute,
  readConsent,
  sanitizePageLocation,
  sanitizeReferrer,
  validMeasurementId,
  writeConsent,
} from "@/lib/analytics/ga";
import GoogleAnalytics from "@/components/analytics/GoogleAnalytics";
import CookieSettingsLink from "@/components/analytics/CookieSettingsLink";

const O = "https://teambalancepro.com";

describe("deployment gate: Production id + Vercel production + production hostname, all required", () => {
  const ok = { measurementId: "G-JMD9EJSF9H", vercelEnv: "production", hostname: "teambalancepro.com" };
  it("passes only when everything matches", () => {
    expect(analyticsAllowed(ok)).toBe(true);
    expect(analyticsAllowed({ ...ok, hostname: "TeamBalancePro.com" })).toBe(true);
  });
  it("missing / malformed id, Preview / Development, or any other hostname → off", () => {
    for (const measurementId of [undefined, null, "", "UA-123-1", "G-", "g-jmd9ejsf9h", "G-JMD9EJSF9H<script>"]) expect(analyticsAllowed({ ...ok, measurementId }), String(measurementId)).toBe(false);
    for (const vercelEnv of [undefined, "", "preview", "development", "Production"]) expect(analyticsAllowed({ ...ok, vercelEnv }), String(vercelEnv)).toBe(false);
    for (const hostname of ["localhost", "soccer-team-generator.vercel.app", "soccer-team-generator-git-x.vercel.app", "www.teambalancepro.com", "teambalancepro.com.evil.example", "evilteambalancepro.com", ""]) expect(analyticsAllowed({ ...ok, hostname }), hostname).toBe(false);
  });
  it("id validation", () => {
    expect(validMeasurementId(" G-JMD9EJSF9H ")).toBe("G-JMD9EJSF9H");
    expect(validMeasurementId("G-JMD9EJSF9H;alert(1)")).toBeNull();
  });
});

describe("route allowlist: exact public pages only; unknown → excluded", () => {
  it("allowlisted pages (and a trailing slash)", () => {
    for (const p of ["/", "/pricing", "/pricing/", "/terms", "/privacy", "/login", "/signup", "/forgot-password", "/verify-email", "/onboarding"]) expect(isAnalyticsRoute(p), p).toBe(true);
  });
  it("token links, player pages, signed-in app, redirects and unknown paths are never tracked", () => {
    const excluded = [
      "/verify-email/abc123token", "/reset-password/abc123token", "/invite/abc123token", "/unsubscribe",
      "/attend", "/share", "/share/m/m1", "/join", "/claim", "/g/org/group", "/g/org/group/m/m1", "/players", "/print/1", "/me", "/me/games",
      "/admin", "/admin/o/new-football-pickup/billing", "/admin/o/x/g/y/matches/m1", "/account/security", "/upgrade",
      "/pricing/x", "/privacy-old", "/loginx", "/signup/extra", "//evil.example/pricing", "pricing", "", "/PRICING", "/api/stripe/webhook",
    ];
    for (const p of excluded) expect(isAnalyticsRoute(p), p).toBe(false);
  });
  it("every allowlisted page has a fixed, non-personal title", () => {
    for (const p of Object.keys(ANALYTICS_ROUTES)) expect(analyticsPageTitle(p), p).toMatch(/^[A-Za-z ]+ — TeamBalance Pro$/);
    expect(analyticsPageTitle("/admin/o/new-football-pickup")).toBeNull();
  });
});

describe("URL sanitization", () => {
  it("drops fragments and every non-approved parameter (tokens, emails, callbackUrl, session_id, org, error)", () => {
    expect(sanitizePageLocation(`${O}/login?callbackUrl=%2Fadmin%2Fo%2Fnew-football-pickup&error=CredentialsSignin#x`)).toBe(`${O}/login`);
    expect(sanitizePageLocation(`${O}/verify-email?email=pat%40example.com&next=%2Fonboarding`)).toBe(`${O}/verify-email`);
    expect(sanitizePageLocation(`${O}/signup?plan=year&org=new-football-pickup&email=a@b.co&token=abc`)).toBe(`${O}/signup?plan=year`);
    expect(sanitizePageLocation(`${O}/pricing?session_id=cs_live_abc&checkout=success`)).toBe(`${O}/pricing`);
    expect(sanitizePageLocation(`${O}/onboarding?plan=month`)).toBe(`${O}/onboarding`); // plan kept only on /pricing and /signup
    expect(sanitizePageLocation(`${O}/?utm_source=google&utm_medium=cpc&utm_campaign=fall-launch&gclid=XYZ&fbclid=abc`)).toBe(`${O}/?utm_source=google&utm_medium=cpc&utm_campaign=fall-launch`);
  });
  it("attribution values that look like personal data or URLs are dropped; plan accepts only month / year", () => {
    expect(sanitizePageLocation(`${O}/?utm_source=pat%40example.com&utm_medium=email&utm_content=hello%20world&utm_term=https%3A%2F%2Fx.y`)).toBe(`${O}/?utm_medium=email`);
    expect(sanitizePageLocation(`${O}/pricing?plan=lifetime`)).toBe(`${O}/pricing`);
  });
  it("excluded pages, malformed URLs and non-web schemes → null (nothing sent)", () => {
    for (const u of [`${O}/attend#token`, `${O}/share/m/m1#t`, `${O}/reset-password/tok`, `${O}/admin/o/x/billing?checkout=success&session_id=cs_live_1`, "not a url", "javascript:alert(1)", "mailto:a@b.co"]) expect(sanitizePageLocation(u), u).toBeNull();
  });
  it("referrer: own allowlisted page → sanitized; own other page → origin; other site → origin only", () => {
    expect(sanitizeReferrer(`${O}/pricing?plan=year&email=a@b.co`, O)).toBe(`${O}/pricing?plan=year`);
    expect(sanitizeReferrer(`${O}/verify-email/secret-token`, O)).toBe(`${O}/`);
    expect(sanitizeReferrer(`${O}/admin/o/new-football-pickup`, O)).toBe(`${O}/`);
    expect(sanitizeReferrer("https://www.google.com/search?q=team+balance+pro", O)).toBe("https://www.google.com/");
    expect(sanitizeReferrer("https://mail.example.com/inbox/123?u=pat@example.com", O)).toBe("https://mail.example.com/");
    expect(sanitizeReferrer("", O)).toBe("");
    expect(sanitizeReferrer("android-app://com.google.android.gm/", O)).toBe("");
  });
});

describe("consent storage: only the choice and a date; failures are safe", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("round trip; undecided → null", () => {
    const s = mem();
    expect(readConsent(s)).toBeNull();
    expect(writeConsent(s, "granted", new Date("2026-10-30T15:00:00Z"))).toBe(true);
    expect(JSON.parse(s.m.get(CONSENT_STORAGE_KEY)!)).toEqual({ status: "granted", decidedAt: "2026-10-30" }); // nothing identifying
    expect(readConsent(s)).toBe("granted");
    writeConsent(s, "denied");
    expect(readConsent(s)).toBe("denied");
  });
  it("blocked / throwing / missing storage and malformed values never crash and never mean 'granted'", () => {
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(readConsent(throwing)).toBeNull();
    expect(writeConsent(throwing, "granted")).toBe(false);
    expect(readConsent(null)).toBeNull();
    expect(writeConsent(undefined, "granted")).toBe(false);
    for (const raw of ["granted", "{", '{"status":"yes"}', '{"status":true}', "null"]) {
      const s = mem();
      s.setItem(CONSENT_STORAGE_KEY, raw);
      expect(readConsent(s), raw).toBeNull();
    }
  });
  it("the property's GA cookies to delete on withdrawal", () => {
    expect(gaCookieNames("G-JMD9EJSF9H")).toEqual(["_ga", "_ga_JMD9EJSF9H"]);
  });
});

describe("server render: no script, no banner, no hydration mismatch", () => {
  it("GoogleAnalytics and CookieSettingsLink render nothing on the server (decided in the browser after mount)", () => {
    expect(renderToStaticMarkup(createElement(GoogleAnalytics))).toBe("");
    expect(renderToStaticMarkup(createElement(CookieSettingsLink, { className: "x" }))).toBe("");
  });
  it("strict collection: GA's kill switch is lifted ONLY around our own sanitized page_view (no automatic GA hits ever)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/components/analytics/GoogleAnalytics.tsx", "utf8");
    expect(src.match(/setCollection\([^)]*, true\)/g)).toEqual(["setCollection(measurementId, true)"]); // once: inside sendPageView
    expect(src).toMatch(/function sendPageView[\s\S]*?setCollection\(measurementId, true\);\s*try \{\s*w\.gtag\?\.\("event", "page_view", params\);\s*\} finally \{\s*setCollection\(measurementId, false\);/);
    expect(src.match(/"event"/g)).toHaveLength(1); // no other event is ever sent
    expect(src).toContain("send_page_view: false");
    expect(src).toContain("onReady={() => setScriptReady(true)}"); // first page_view only after gtag.js is ready
  });
  it("the Measurement ID is never hard-coded in source", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/components/analytics/GoogleAnalytics.tsx", "src/components/analytics/useAnalyticsEnvironment.ts", "src/components/analytics/CookieSettingsLink.tsx", "src/lib/analytics/ga.ts", "src/app/layout.tsx"]) expect(fs.readFileSync(f, "utf8"), f).not.toContain("JMD9EJSF9H");
  });
});
