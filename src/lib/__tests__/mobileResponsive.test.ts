import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Mobile responsiveness — regression guards (source-level; the project has no browser test runner).
 * Root cause of the iPhone bug: WebKit's RenderThemeIOS::adjustInputElementButtonStyle styles every
 * date/time input that keeps its NATIVE appearance and has no fixed width — it forces padding
 * "0 0.5em", a min-width of the longest localized date and box-sizing: content-box, so `w-full`
 * became 100% + padding + border and the field stuck out of its card. `.date-input` turns the native
 * appearance off (the native picker stays: it belongs to the input type).
 */
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []));
const G = "src/app/admin/o/[organizationSlug]/g/[groupSlug]";

describe("native date / time inputs (the iPhone Safari bug)", () => {
  it(".date-input disables the iOS native appearance and restates border-box sizing", () => {
    const css = read("src/app/globals.css");
    const rule = css.slice(css.indexOf(".date-input {"), css.indexOf("}", css.indexOf(".date-input {")));
    for (const decl of ["-webkit-appearance: none;", "appearance: none;", "box-sizing: border-box;", "min-width: 0;", "max-width: 100%;"]) expect(rule).toContain(decl);
    expect(css).toMatch(/\.date-input::-webkit-date-and-time-value \{[^}]*text-align: start;/);
  });
  it("EVERY date / time / datetime-local input in the app uses .date-input", () => {
    const missing: string[] = [];
    let found = 0;
    for (const f of walk("src")) {
      const lines = read(f).split("\n");
      lines.forEach((l, i) => {
        if (!/type="(date|time|datetime-local)"/.test(l)) return;
        found++;
        if (!lines.slice(Math.max(0, i - 3), i + 6).join("\n").includes("date-input")) missing.push(`${f}:${i + 1}`);
      });
    }
    expect(found).toBeGreaterThanOrEqual(13);
    expect(missing).toEqual([]);
  });
  it("no broad overflow hack on the page body", () => {
    expect(read("src/app/globals.css")).not.toMatch(/(html|body)[^{]*\{[^}]*overflow-x\s*:\s*hidden/);
  });
});

describe("narrow-screen layout fixes", () => {
  it("New match form: one shrinkable column on mobile; grid items may shrink", () => {
    const f = read(`${G}/matches/CreateMatchForm.tsx`);
    expect(f).toContain('<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">');
    expect(f.match(/<div className="min-w-0">/g)?.length).toBeGreaterThanOrEqual(3);
    expect(f).toContain('className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0"');
  });
  it("Edit match form: one shrinkable column on mobile; fields may shrink", () => {
    expect(read(`${G}/matches/[matchId]/MatchWorkspace.tsx`)).toContain("mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] [&>*]:min-w-0");
  });
  it("selects with long option names (Telegram group, community) may shrink to the screen", () => {
    const ws = read(`${G}/matches/[matchId]/MatchWorkspace.tsx`);
    expect(ws).toContain('<label className="flex min-w-0 max-w-full flex-wrap items-center gap-2 font-semibold">');
    expect(ws).toContain('className="h-9 w-full min-w-0 max-w-full rounded-tbp-sm border border-input bg-card px-2 font-normal sm:w-auto"');
    expect(ws).toContain('<select id="match-community" className="h-9 w-full min-w-0 max-w-full');
    expect(read(`${G}/settings/CommunitiesSection.tsx`)).toContain('className="h-9 w-full min-w-0 max-w-full rounded-md border px-2 text-sm sm:w-auto"');
  });
  it("Organization page: cards in one shrinkable column on mobile", () => {
    const f = read("src/app/admin/o/[organizationSlug]/page.tsx");
    expect(f).toContain('<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">');
    expect(f.match(/className="min-w-0 rounded-tbp-2xl border/g)?.length).toBe(2);
  });
  it("Overview stat tiles fit three across at 320px", () => {
    expect(read(`${G}/page.tsx`)).toContain('<div className="min-w-0 rounded-tbp bg-muted px-2 py-2 sm:px-3">');
  });
  it("recaps wrap long words and URLs (public page, match workspace, My games)", () => {
    expect(read("src/components/match-link/MatchView.tsx")).toContain('className="whitespace-pre-line break-words text-sm leading-relaxed"');
    expect(read(`${G}/matches/[matchId]/PostGameSection.tsx`)).toContain('className="whitespace-pre-line break-words text-sm"');
    expect(read("src/app/me/page.tsx")).toContain('className="whitespace-pre-line break-words text-muted-foreground"');
  });
  it("pricing table fits a 320px screen (scrolls only below it)", () => {
    const f = read("src/components/billing/PlanComparison.tsx");
    expect(f).toContain('<table className="w-full min-w-[17.5rem] text-sm">');
    expect(f).not.toMatch(/className="p-3 /);
  });
});
