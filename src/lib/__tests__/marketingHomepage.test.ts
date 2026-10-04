import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * UI-1 — `/` is the Team Balance Pro marketing homepage (no longer a redirect
 * to the default public Group). Presentation-only: no tenant, session or
 * production data; CTAs go to the existing /login and /signup; every other
 * route keeps the old global chrome exactly.
 */

const nav = vi.hoisted(() => ({ pathname: "/" as string | null, redirect: vi.fn((url: string) => { throw new Error(`redirect(${url})`); }) }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, redirect: nav.redirect, notFound: () => { throw new Error("notFound"); } }));
vi.mock("next/image", () => ({ default: (p: { alt: string; className?: string }) => createElement("img", { alt: p.alt, className: p.className }) }));
const hdr = vi.hoisted(() => ({ chrome: null as string | null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(hdr.chrome === null ? {} : { "x-tbp-chrome": hdr.chrome }) }));
vi.mock("next/font/google", () => ({ Archivo: () => ({ variable: "font-display-var" }), Manrope: () => ({ variable: "font-body-var" }) }));
const settings = vi.hoisted(() => ({ getTeamName: vi.fn(async () => "Team Balance Pro") }));
vi.mock("@/lib/settings", () => settings);
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import MarketingHomePage, { metadata } from "@/app/page";
import RootLayout from "@/app/layout";
import { NextRequest } from "next/server";
import { middleware, config as middlewareConfig } from "@/middleware";
import { CHROME_HEADER, REDESIGN_CHROME, chromeModeFromHeader, isRedesignedPath } from "@/lib/chrome";

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const render = () => renderToStaticMarkup(createElement(MarketingHomePage));
const hrefsFor = (html: string, text: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter((m) => m[2].replace(/<[^>]+>/g, "").trim() === text).map((m) => m[1]);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  nav.pathname = "/";
  nav.redirect.mockClear();
  hdr.chrome = null;
  settings.getTeamName.mockClear();
});

describe("/ renders the marketing homepage", () => {
  it("1: renders the homepage (no redirect to the default public Group)", () => {
    const html = render();
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(html).toContain("Better teams.");
    expect(read("src/app/page.tsx")).not.toMatch(/redirect\(|getDefaultPublicGroupSlugs|defaultPublicGroup|DEFAULT_PUBLIC/);
    expect(metadata.title).toBe("Team Balance Pro — Fair teams for pickup sports");
  });

  it("approved hero copy, exactly one H1, sections with anchors", () => {
    const html = render();
    const text = visibleText(html);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(text).toContain("For pickup games & leagues");
    expect(text).toContain("Better teams. Better games. Less organizing.");
    expect(text).toContain("Create fair, balanced teams for pickup games, leagues, and recreational sports in seconds.");
    expect(text).toContain("Soccer · Basketball · Volleyball · Football · and more");
    for (const id of ["how", "features", "sports", "main"]) expect(html, id).toContain(`id="${id}"`);
    for (const h of ["Balanced automatically", "Built for game day", "Multiple sports", "Less organizer work", "Create your group", "Add your players", "Organize a match", "Generate balanced teams", "Ready for a better game?"]) expect(text, h).toContain(h);
  });

  it("4: CTAs target the existing routes", () => {
    const html = render();
    expect(new Set(hrefsFor(html, "Create Your Group"))).toEqual(new Set(["/signup"]));
    expect(new Set(hrefsFor(html, "Get Started"))).toEqual(new Set(["/signup"]));
    expect(new Set(hrefsFor(html, "Sign In"))).toEqual(new Set(["/login"]));
    expect(hrefsFor(html, "See How It Works")).toEqual(["#how"]);
    expect(hrefsFor(html, "How It Works")).toContain("#how");
    expect(hrefsFor(html, "Features")).toContain("#features");
    expect(hrefsFor(html, "Sports")).toContain("#sports");
    // Every link stays on the marketing page or goes to an existing public auth route.
    const all = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(all.every((h) => ["/", "/login", "/signup"].includes(h) || h.startsWith("#"))).toBe(true);
  });

  it("sports come from the production registry (user-facing labels, never internal keys)", () => {
    const text = visibleText(render());
    for (const s of ["Soccer", "Basketball", "Volleyball", "American Football", "Other"]) expect(text, s).toContain(s);
    expect(text).toContain("Guards, Wings, Bigs");
    expect(text).toContain("Quarterbacks, Receivers, Rushers / Linemen");
    expect(text).not.toMatch(/flag_football|flagFootball|FLAG_FOOTBALL/);
  });

  it("5: illustrative content only — no real users, tenant, admin or private data; no unsupported claims", () => {
    const html = render();
    const text = visibleText(html);
    expect(text).toContain("Example match");
    expect(text).not.toMatch(/Yasmina|Forekicks|New England Eagles|Indoor Soccer|indoor-soccer|new-england-eagles/i);
    expect(text).not.toMatch(/rating|EXCELLENT|VERY_GOOD|@[a-z0-9.-]+\.[a-z]{2,}|telegramUserId|userId|playerId/i);
    expect(text).not.toMatch(/WhatsApp|reminder|GPS|\bAI\b|artificial intelligence|thousands|customers|testimonial|\d+\s?%|guarantee|pricing|\$\d/i);
  });

  it("a11y basics: skip link, labelled nav, decorative icons hidden, menu button labelled", () => {
    const html = render();
    expect(html).toContain('href="#main"');
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain('aria-label="Footer"');
    expect(html).toContain('aria-label="Open menu"');
    expect(html).toContain('aria-expanded="false"');
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    expect(svgs.every((s) => s.includes('aria-hidden="true"'))).toBe(true);
    expect(html).toMatch(/<img alt=""/); // decorative photo
  });
});

describe("3: presentation only — no tenant inference, session, data or storage", () => {
  const files = ["src/app/page.tsx", "src/components/marketing/MarketingHeader.tsx", "src/components/marketing/parts.tsx", "src/lib/marketing/sports.ts"];
  it("imports only UI, routing primitives and the sport registry", () => {
    for (const f of files) {
      const src = read(f);
      // (Marketing copy may mention "Telegram"; actual modules are covered by the import allow-list below.)
      expect(src, f).not.toMatch(/prisma|next-auth|getServerSession|TenantContext|tenantContext|cookies\(|headers\(|localStorage|sessionStorage|document\.cookie|\bfetch\(|openai|defaultPublicGroup|DEFAULT_PUBLIC|organizationSlug|groupSlug/i);
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(["react", "next/link", "next/image", "lucide-react", "@/components/ui/button", "@/components/marketing/MarketingHeader", "@/components/marketing/parts", "@/lib/marketing/sports", "@/lib/sports", "@/lib/cn", "../../public/marketing/pickup-game.jpg"], `${f}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});

describe("server/client boundary", () => {
  it("server files import only the DEFAULT component from \"use client\" modules (plain values would arrive as client references)", () => {
    const clientModules = ["@/components/marketing/MarketingHeader", "@/components/ChromeBoundaryGuard", "@/components/ui/button"];
    for (const f of ["src/app/page.tsx", "src/components/marketing/parts.tsx", "src/app/layout.tsx"]) {
      const src = read(f);
      for (const m of src.matchAll(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm)) {
        if (!clientModules.includes(m[2]) || m[2] === "@/components/ui/button") continue;
        expect(m[1], `${f} imports ${m[1]} from ${m[2]}`).toMatch(/^[A-Za-z]+$/); // default import only
      }
    }
    expect(read("src/components/marketing/MarketingHeader.tsx")).not.toMatch(/^export const /m);
  });
});

describe("chrome isolation: decided on the server; every other route keeps the old global chrome exactly", () => {
  const renderLayout = async (chrome: string | null) => {
    hdr.chrome = chrome;
    return renderToStaticMarkup(await RootLayout({ children: createElement("p", null, "PAGE") }));
  };
  const expectLegacyChrome = (html: string) => {
    expect(html).toContain("url(&#x27;/SoccerTeam.jpg&#x27;)");
    expect(html).toContain('<main class="max-w-6xl mx-auto px-4 py-6"><p>PAGE</p></main>');
    expect(html).toContain('<div class="fixed inset-0 -z-10 bg-white/70"></div>');
    expect(html).toContain("<header");
    expect(html).toMatch(/<footer class="border-t bg-white\/80 mt-12 print:hidden">[\s\S]*Team Balance Pro/);
  };

  it("the marketing tag (set by middleware for / only) renders the page without the old background, header or footer", async () => {
    const html = await renderLayout(REDESIGN_CHROME);
    expect(html).toMatch(/<body class="min-h-screen text-slate-900 relative overflow-x-hidden"><p>PAGE<\/p><\/body>/);
    expect(html).not.toMatch(/SoccerTeam|<header|<footer/);
    expect(settings.getTeamName).not.toHaveBeenCalled();
  });
  it.each(["/g/new-england-eagles/indoor-soccer", "/g/o/g/m/abc", "/g/no-org/no-group (nested notFound)", "/share/m/abc", "/admin", "/me", "/login", "/signup", "/claim", "/players"])(
    "%s (no tag) server-renders the old chrome",
    async () => expectLegacyChrome(await renderLayout(null)),
  );
  it("any other tag value is ignored (legacy chrome)", async () => {
    expectLegacyChrome(await renderLayout("yes"));
    expect(chromeModeFromHeader("Redesign")).toBe("legacy");
    expect(chromeModeFromHeader("marketing")).toBe("legacy");
  });
  it("redesigned paths: /, the auth screens and (UI-3) the app shell — nothing else (no tenant, session, cookie or storage input)", () => {
    for (const p of ["/", "/login", "/signup", "/verify-email", "/verify-email/abc", "/admin", "/admin/o/x/g/y", "/me", "/account/security"])
      expect(isRedesignedPath(p), p).toBe(true);
    for (const p of ["/g/o/g", "/g/o/g/m/x", "/players", "/login/x", "/signup2", "/verify-emailx", "/adminx", "/onboarding", "/claim", "/invite/t", "/share/m/x", "/print/x", "", null, undefined])
      expect(isRedesignedPath(p), String(p)).toBe(false);
    const code = read("src/lib/chrome.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/import|cookies|localStorage|session|tenant|fetch\(/i);
  });
  it.each(["/", "/login?callbackUrl=%2Fadmin", "/signup?invite=x", "/verify-email", "/verify-email/tok?next=%2Fme"])(
    "middleware tags %s with the redesign header WITHOUT auth-gating it",
    async (url) => {
      const res = await middleware(new NextRequest(`http://localhost${url}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get(`x-middleware-request-${CHROME_HEADER}`)).toBe(REDESIGN_CHROME);
    }
  );
  it("the static middleware matcher covers exactly the redesigned paths", () => {
    for (const p of ["/", "/login", "/signup", "/verify-email/:path*"]) expect(middlewareConfig.matcher).toContain(p);
  });
  it("the chrome markup is the pre-UI-1 root-layout markup moved verbatim into a SERVER component", () => {
    const src = read("src/components/LegacyChrome.tsx");
    expect(src).not.toContain('"use client"');
    expect(src).not.toMatch(/usePathname/);
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('{mode === "redesign" ? children : <LegacyChrome teamName={teamName}>{children}</LegacyChrome>}');
    expect(layout).toContain("<ChromeBoundaryGuard mode={mode} />");
  });
  it("a client-side navigation across the boundary reloads so the server picks the chrome", () => {
    const guard = read("src/components/ChromeBoundaryGuard.tsx");
    expect(guard).toContain('"use client"');
    expect(guard).toContain('isRedesignedPath(pathname) !== (mode === "redesign")) window.location.reload()');
  });
});

describe("2: canonical public / tenant routes are untouched", () => {
  it("canonical group, match, share, admin, me, claim and invite pages still exist; /players keeps its default-group redirect", () => {
    for (const f of [
      "src/app/g/[organizationSlug]/[groupSlug]/page.tsx",
      "src/app/g/[organizationSlug]/[groupSlug]/m/[matchId]/page.tsx",
      "src/app/share/m/[matchId]/page.tsx",
      "src/app/admin/page.tsx",
      "src/app/me/page.tsx",
      "src/app/claim/page.tsx",
      "src/app/login/page.tsx",
      "src/app/signup/page.tsx",
    ])
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    expect(read("src/app/players/page.tsx")).toContain("getDefaultPublicGroupSlugs");
    expect(fs.existsSync(path.join(root, "src/lib/defaultPublicGroup.ts"))).toBe(true);
  });
});
