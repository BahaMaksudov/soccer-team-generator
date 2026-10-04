import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { isUpcomingYmd, matchLifecycle, type LifecycleInput } from "@/lib/matchLifecycle";
import { LifecycleSteps } from "@/components/game-day/parts";
import { MatchList } from "@/components/game-day/MatchList";
import type { OverviewMatch } from "@/lib/groupOverview";
import { adminMatchesPath, canonicalAdminMatchPath } from "@/lib/matchPaths";

/**
 * UI-4 — game-day presentation: the lifecycle is DERIVED from real state
 * (never stored, never gating), there is ONE suggested next step, and the
 * final M9 post-game architecture (Match Summary = the only post-game send)
 * is intact in the redesigned components.
 */

const TODAY = "2026-10-04";
const base = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  status: "SCHEDULED",
  date: "2026-10-10",
  today: TODAY,
  attendanceClosed: false,
  playing: 0,
  teamsPublished: false,
  result: { saved: false, published: false },
  mvpPublished: false,
  recap: { saved: false, published: false },
  summary: "not_posted",
  canManage: true,
  ...over,
});
const next = (over: Partial<LifecycleInput>) => matchLifecycle(base(over)).next?.label ?? null;
const past = { date: "2026-10-01", teamsPublished: true, playing: 10 } as const;

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const MATCH_DIR = "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches";

describe("upcoming / past uses exactly listMatches()'s rule", () => {
  it("SCHEDULED and dated today or later is upcoming; everything else is past", () => {
    expect(isUpcomingYmd("SCHEDULED", TODAY, TODAY)).toBe(true);
    expect(isUpcomingYmd("SCHEDULED", "2026-10-03", TODAY)).toBe(false);
    expect(isUpcomingYmd("COMPLETED", "2026-12-01", TODAY)).toBe(false);
    expect(isUpcomingYmd("CANCELED", "2026-12-01", TODAY)).toBe(false);
    // listMatches() source still uses the same predicate.
    expect(read("src/lib/matches.ts")).toContain('m.status === "SCHEDULED" && m.date.getTime() >= today');
  });
});

describe("one suggested next step, derived from real state", () => {
  it("before teams: attendance first, then generate (attendance closing is NOT required by the backend)", () => {
    expect(next({})).toBe("Manage attendance");
    expect(next({ playing: 8 })).toBe("Generate teams");
    expect(next({ attendanceClosed: true })).toBe("Generate teams");
  });
  it("teams published before the game → review; after the date → result", () => {
    expect(next({ teamsPublished: true, playing: 8 })).toBe("Review teams");
    expect(next({ ...past })).toBe("Enter result");
    // COMPLETED with a future date is already past (no "mark complete" step needed).
    expect(next({ teamsPublished: true, status: "COMPLETED" })).toBe("Enter result");
  });
  it("post-game order: result → publish → Player of the Match → recap → Match Summary", () => {
    expect(next({ ...past, result: { saved: true, published: false } })).toBe("Publish result");
    expect(next({ ...past, result: { saved: true, published: true } })).toBe("Decide Player of the Match");
    expect(next({ ...past, result: { saved: true, published: true }, mvpPublished: true })).toBe("Write recap");
    expect(next({ ...past, result: { saved: true, published: true }, mvpPublished: true, recap: { saved: true, published: false } })).toBe("Publish recap");
    const all = { ...past, result: { saved: true, published: true }, mvpPublished: true, recap: { saved: true, published: true } };
    expect(next(all)).toBe("Post Match Summary");
    expect(next({ ...all, summary: "updated_available" })).toBe("Post updated Match Summary");
    expect(next({ ...all, summary: "sending" })).toBeNull();
    const done = matchLifecycle(base({ ...all, summary: "posted" }));
    expect(done.next).toBeNull();
    expect(done.phase).toBe("complete");
    expect(done.stages.every((s) => s.state === "done")).toBe(true);
  });
  it("UI-4A — MEMBER is read-only: never any call to action; the pending stage is still shown truthfully", () => {
    for (const over of [{}, { playing: 5 }, { teamsPublished: true }, { ...past }, { ...past, result: { saved: true, published: false } }, { ...past, result: { saved: true, published: true } }]) {
      const l = matchLifecycle(base({ ...over, canManage: false, summary: null }));
      expect(l.next, JSON.stringify(over)).toBeNull();
    }
    const m = matchLifecycle(base({ ...past, canManage: false, summary: null, result: { saved: true, published: false } }));
    expect(m.stages.find((s) => s.state === "current")?.key).toBe("result");
    expect(m.phase).toBe("postgame");
    expect(m.stages.find((s) => s.key === "summary")?.detail).toBe("Owner/admin posts");
    const all = matchLifecycle(base({ ...past, canManage: false, summary: null, result: { saved: true, published: true }, mvpPublished: true, recap: { saved: true, published: true } }));
    expect(all.phase).toBe("complete");
  });
  it("OWNER/ADMIN without a Telegram group yet (no delivery state): summary is 'Not posted' and still the next step", () => {
    const all = { ...past, result: { saved: true, published: true }, mvpPublished: true, recap: { saved: true, published: true }, summary: null };
    const l = matchLifecycle(base(all));
    expect(l.stages.find((s) => s.key === "summary")?.detail).toBe("Not posted");
    expect(l.next?.label).toBe("Post Match Summary");
  });
  it("canceled: no next step", () => {
    const l = matchLifecycle(base({ status: "CANCELED", ...past }));
    expect(l.phase).toBe("canceled");
    expect(l.next).toBeNull();
  });
  it("exactly one stage is 'current', and only when there is a next step", () => {
    for (const over of [{}, { playing: 3 }, { ...past }, { ...past, result: { saved: true, published: true } }]) {
      const l = matchLifecycle(base(over));
      expect(l.stages.filter((s) => s.state === "current").map((s) => s.key)).toEqual(l.next ? [l.next.key] : []);
    }
  });
  it("never invents a completion or per-item post action", () => {
    const labels = new Set<string>();
    const states = [
      {},
      { playing: 1 },
      { teamsPublished: true },
      { ...past },
      { ...past, result: { saved: true, published: false } },
      { ...past, result: { saved: true, published: true } },
      { ...past, result: { saved: true, published: true }, mvpPublished: true, recap: { saved: true, published: true } },
    ];
    for (const s of states) for (const canManage of [true, false]) labels.add(next({ ...s, canManage }) ?? "");
    for (const l of labels) expect(l).not.toMatch(/mark.*complete|complete match|Post (Result|MVP|Player|Recap)/i);
  });
});

describe("rendering", () => {
  it("progress steps spell out their state (never color alone) and mark the current step", () => {
    const html = renderToStaticMarkup(createElement(LifecycleSteps, { lifecycle: matchLifecycle(base({ ...past })), linkBase: "/m" }));
    expect(html).toContain('aria-label="Match progress"');
    expect(html).toMatch(/aria-current="step"[\s\S]*?Next: <\/span>Not entered/);
    expect(html).toContain("Done: </span>Published");
    expect(html).toContain('href="/m#result"');
  });
  it("match rows link to the canonical Match workspace and show only PUBLISHED scores", () => {
    const m = (over: Partial<OverviewMatch>): OverviewMatch => ({
      id: "x",
      href: canonicalAdminMatchPath("o", "g", "x"),
      date: "2026-10-01",
      startTime: "19:30",
      locationName: "Field 2",
      status: "SCHEDULED",
      upcoming: false,
      attendanceClosed: true,
      teamsPublished: true,
      publishedScores: null,
      resultSaved: true,
      lifecycle: matchLifecycle(base({ ...past, result: { saved: true, published: false } })),
      ...over,
    });
    const html = renderToStaticMarkup(createElement(MatchList, { matches: [m({}), m({ id: "y", publishedScores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] })], emptyText: "none" }));
    expect(html).toContain('href="/admin/o/o/g/g/matches/x"');
    expect(html).toContain("Result not published");
    expect(html).toContain("Next: Publish result");
    expect(html).toMatch(/Team 1 <\/span>5[\s\S]*Team 2 <\/span>3/);
    expect(adminMatchesPath("a b", "c")).toBe("/admin/o/a%20b/g/c/matches");
  });
});

describe("M9 invariants in the redesigned components", () => {
  const pg = read(`${MATCH_DIR}/[matchId]/PostGameSection.tsx`);
  const ws = read(`${MATCH_DIR}/[matchId]/MatchWorkspace.tsx`);
  it("Match Summary is the ONLY post-game Telegram send; no result/MVP/recap send buttons", () => {
    expect(pg.match(/<PostButton /g)).toHaveLength(1);
    expect(pg).toContain('<PostButton state={m.summary} label="Match Summary"');
    expect(pg.match(/action: "post_message"/g)).toHaveLength(1);
    expect(pg).toContain('kind: "summary"');
    expect(pg + ws).not.toMatch(/Post (Updated )?(Result|Recap|MVP|Player of the Match) to Telegram|kind: "(result|mvp|recap)"/);
  });
  it("readiness and MVP state come from the existing helpers, not re-implemented", () => {
    expect(pg).toContain("summaryReadiness(pg, canManage)");
    expect(pg).toContain("mvpStage(pg, canManage, chosenMethod)");
    expect(pg).toContain("resultEditorState(");
  });
  it("sections are addressable for the next-step pointer", () => {
    for (const id of ["result", "mvp", "recap", "summary"]) expect(pg).toContain(`id="${id}"`);
    for (const id of ["attendance", "teams"]) expect(ws).toContain(`id="${id}"`);
  });
  it("no new 'mark complete' affordance (the existing Mark completed status control is unchanged)", () => {
    expect(ws).not.toMatch(/Mark Match Complete|Complete Match/i);
    expect(ws).toContain('saveMatch({ status: "COMPLETED" }, "Marked as completed.")');
  });
  it("legacy Delete-by-date stays hidden in the Match workspace (match mode)", () => {
    expect(read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalGenerateSection.tsx")).toMatch(/\{!matchId && \(\s*<div className="pt-3 border-t space-y-2">\s*<div className="text-sm font-medium">Delete Published Teams/);
    expect(ws).not.toMatch(/deletePublished|Delete Published/);
  });
});

describe("routing, privacy and no mock data", () => {
  it("Matches is a real canonical page; the old in-page section is gone", () => {
    expect(fs.existsSync(path.join(root, `${MATCH_DIR}/page.tsx`))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalMatchesSection.tsx"))).toBe(false);
    expect(read(`${MATCH_DIR}/page.tsx`)).toContain("loadCanonicalAdminContext(await params)");
    expect(read(`${MATCH_DIR}/page.tsx`)).toContain("if (!context) notFound();");
  });
  it("public / share pages never import the organizer read model or game-day components", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []));
    for (const f of [...walk("src/app/g"), ...walk("src/app/share"), "src/lib/matchPage.ts"]) {
      expect(read(f), f).not.toMatch(/groupOverview|components\/game-day|matchLifecycle/);
    }
  });
  it.each([
    "src/lib/matchLifecycle.ts",
    "src/lib/groupOverview.ts",
    "src/components/game-day/parts.tsx",
    "src/components/game-day/MatchList.tsx",
    "src/app/admin/o/[organizationSlug]/g/[groupSlug]/page.tsx",
    `${MATCH_DIR}/page.tsx`,
    `${MATCH_DIR}/CreateMatchForm.tsx`,
    `${MATCH_DIR}/[matchId]/MatchWorkspace.tsx`,
    `${MATCH_DIR}/[matchId]/PostGameSection.tsx`,
  ])("%s has no Lovable mock data / preview infrastructure", (f) => {
    expect(read(f)).not.toMatch(/usePreview|AppPreview|MATCH_STAGES|Sunday (Indoor|Pickup) Soccer|Yasmina|Bahrom|Forekicks|Marcus L|localStorage|sessionStorage/);
  });
});
