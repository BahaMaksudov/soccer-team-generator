import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pill, SaveState } from "@/components/ui/pill";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

/**
 * UI-0 — Team Balance Pro design foundation. Tokens exist, fonts are wired as
 * variables only, primitives are presentation-only, and NO existing page has
 * adopted the new design yet (no global restyle in UI-0).
 */

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const css = read("src/app/globals.css");
const layout = read("src/app/layout.tsx");
const tailwind = createRequire(import.meta.url)(path.join(root, "tailwind.config.js")) as {
  theme: { extend: { colors: Record<string, unknown>; borderRadius: Record<string, string>; boxShadow: Record<string, string>; fontFamily: Record<string, string[]> } };
};

const TOKENS = [
  "radius",
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "pitch",
  "pitch-foreground",
  "team-a",
  "team-b",
  "shadow-card",
  "shadow-lift",
];

describe("design tokens", () => {
  it("every approved token is defined as a --tbp-* CSS variable", () => {
    for (const t of TOKENS) expect(css, t).toMatch(new RegExp(`--tbp-${t}:\\s*[^;]+;`));
    expect(css).toContain("--tbp-primary: 0.42 0.1 158;"); // pitch green
    expect(css).toContain("--tbp-accent: 0.72 0.17 55;"); // orange
  });
  it("Tailwind exposes them with opacity support; no shadcn chart/sidebar clutter; no dark mode", () => {
    const c = tailwind.theme.extend.colors;
    for (const k of ["background", "foreground", "card", "primary", "secondary", "muted", "accent", "destructive", "border", "input", "ring", "pitch", "team-a", "team-b"]) expect(c, k).toHaveProperty(k);
    expect((c.primary as Record<string, string>).DEFAULT).toBe("oklch(var(--tbp-primary) / <alpha-value>)");
    expect(Object.keys(c).some((k) => /chart|sidebar|popover/.test(k))).toBe(false);
    expect(css).not.toMatch(/\.dark|prefers-color-scheme|chart-|sidebar-/);
    expect(tailwind.theme.extend.boxShadow).toEqual({ card: "var(--tbp-shadow-card)", lift: "var(--tbp-shadow-lift)" });
  });
  it("is additive only: Tailwind defaults (rounded-*, font-sans) are not overridden and no element is restyled globally", () => {
    expect(Object.keys(tailwind.theme.extend.borderRadius).every((k) => k.startsWith("tbp"))).toBe(true);
    expect(Object.keys(tailwind.theme.extend.fontFamily).sort()).toEqual(["body", "display"]);
    // No element selectors / global rules (body, html, h1–h4, *, :focus-visible) in the stylesheet.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ""); // ignore comments
    expect(rules).not.toMatch(/^\s*(html|body|h[1-6]|\*|:focus-visible)[\s,{]/m);
    expect(css).toMatch(/@layer utilities \{[\s\S]*\.eyebrow[\s\S]*\.pitch-lines/);
  });
});

describe("fonts", () => {
  it("Archivo (display) and Manrope (body) via next/font/google, exposed as CSS variables on <html> only", () => {
    expect(layout).toContain('import { Archivo, Manrope } from "next/font/google";');
    expect(layout).toContain('variable: "--font-tbp-display"');
    expect(layout).toContain('variable: "--font-tbp-body"');
    expect(layout).toContain('<html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>');
    expect(tailwind.theme.extend.fontFamily.display[0]).toBe("var(--font-tbp-display)");
    expect(tailwind.theme.extend.fontFamily.body[0]).toBe("var(--font-tbp-body)");
    expect(layout).not.toMatch(/fonts\.googleapis|fonts\.gstatic/); // no runtime Google Fonts request
  });
  it("the existing body chrome is unchanged (background, SiteHeader, footer — in LegacyChrome since UI-1)", () => {
    expect(layout).toContain('<body className="min-h-screen text-slate-900 relative overflow-x-hidden">');
    const chrome = read("src/components/LegacyChrome.tsx");
    expect(chrome).toContain("url('/SoccerTeam.jpg')");
    expect(chrome).toContain("<SiteHeader teamName={teamName} />");
    expect(layout).not.toMatch(/displayFont\.className|bodyFont\.className/); // fonts are not applied anywhere yet
  });
});

describe("UI primitives are presentation-only", () => {
  const dir = path.join(root, "src/components/ui");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  it("the expected set exists", () => {
    expect(files.sort()).toEqual(["badge.tsx", "button.tsx", "card.tsx", "input.tsx", "label.tsx", "pill.tsx", "textarea.tsx"]);
  });
  it("no data, auth, tenant, Telegram, AI or network code", () => {
    const allowedImports = new Set(["react", "@radix-ui/react-slot", "class-variance-authority", "lucide-react", "@/lib/cn"]);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) expect(allowedImports.has(m[1]), `${f} imports ${m[1]}`).toBe(true);
      expect(src, f).not.toMatch(/\bfetch\(|prisma|next-auth|getServerSession|TenantContext|tenantContext|telegram|openai|localStorage|sessionStorage|document\.cookie/i);
    }
    const cnSrc = read("src/lib/cn.ts");
    expect([...cnSrc.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort()).toEqual(["clsx", "tailwind-merge"]);
  });
  it("only the redesigned pages use the primitives (UI-0 is opt-in; UI-1 = homepage, UI-2 = auth screens, UI-3 = app shell)", () => {
    const users: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && !p.includes(`${path.sep}__tests__${path.sep}`) && !p.includes(`${path.sep}components${path.sep}ui${path.sep}`)) {
          if (/@\/components\/ui\/|@\/lib\/cn"/.test(fs.readFileSync(p, "utf8"))) users.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "src"));
    expect(users.sort()).toEqual(
      [
        "src/app/page.tsx",
        "src/components/marketing/MarketingHeader.tsx",
        "src/components/marketing/parts.tsx",
        "src/app/signup/page.tsx",
        "src/app/verify-email/page.tsx",
        "src/app/verify-email/ResendVerification.tsx",
        "src/app/verify-email/[token]/page.tsx",
        "src/app/verify-email/[token]/VerifyEmailButton.tsx",
        "src/components/auth/AuthLayout.tsx",
        "src/components/auth/fields.tsx",
        "src/components/auth/parts.tsx",
        "src/app/admin/page.tsx",
        "src/components/app-shell/AppShell.tsx",
        "src/components/app-shell/ShellClient.tsx",
      ].sort()
    );
  });
});

describe("primitive behavior", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  it("cn merges and lets later Tailwind classes win", () => {
    expect(cn("px-2 text-sm", false && "hidden", "px-4")).toBe("text-sm px-4");
  });
  it("Button: type=button by default (never submits by accident); variants; asChild renders the child element", () => {
    const b = html(createElement(Button, null, "Save"));
    expect(b).toMatch(/^<button[^>]*type="button"/);
    expect(b).toContain("bg-primary");
    expect(html(createElement(Button, { type: "submit", variant: "outline", size: "sm" }, "Go"))).toMatch(/type="submit"[^>]*class="[^"]*border-input[^"]*h-8/);
    const link = html(createElement(Button, { asChild: true, variant: "accent" }, createElement("a", { href: "/somewhere" }, "Open")));
    expect(link).toMatch(/^<a [^>]*href="\/somewhere"/);
    expect(link).toContain("bg-accent");
    expect(link).not.toContain("<button");
  });
  it("Badge / Pill / SaveState / Card / Input / Textarea / Label render plain accessible markup", () => {
    expect(html(createElement(Badge, { variant: "secondary" }, "Soccer"))).toMatch(/^<span[^>]*bg-secondary[^>]*>Soccer<\/span>$/);
    expect(html(createElement(Pill, { tone: "accent" }, "Needs update"))).toContain("bg-accent/15");
    expect(html(createElement(SaveState, { state: "unsaved" }))).toContain("Not entered");
    expect(html(createElement(SaveState, { state: "dirty" }))).toContain("Unsaved changes");
    const saved = html(createElement(SaveState, { state: "saved", savedLabel: "Recap saved" }));
    expect(saved).toContain("Recap saved");
    expect(saved).toContain('aria-hidden="true"'); // decorative icon
    expect(html(createElement(Card, null, createElement(CardTitle, null, "Next match")))).toMatch(/^<div[^>]*shadow-card[^>]*><h3[^>]*font-display/);
    expect(html(createElement(Input, { id: "s", "aria-invalid": true }))).toMatch(/^<input[^>]*type="text"[^>]*aria-invalid="true"/);
    expect(html(createElement(Textarea, { defaultValue: "<b>x</b>" }))).toContain("&lt;b&gt;x&lt;/b&gt;"); // escaped text
    expect(html(createElement(Label, { htmlFor: "s" }, "Score"))).toMatch(/^<label[^>]*for="s"/);
  });
});
