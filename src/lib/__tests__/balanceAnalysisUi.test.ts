import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BalanceIntelligence from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/BalanceIntelligence";
import { analyzeTeams } from "@/lib/balanceAnalysis";
import { applySwapBody, describeSwap, QUALITY_LABEL } from "@/lib/balanceAnalysisUi";
import { evaluateTeams, resolveBalanceConfig } from "@/lib/balanceEngine";
import { findSport, sportClientView } from "@/lib/sports";

const other = findSport("other")!;
const vb = findSport("volleyball")!;
const pl = (id: string, firstName: string, rating: string, position = "PLAYER") => ({ id, firstName, lastName: "X", position, rating, stamina: 3 });
const teams = [
  { teamNumber: 1, players: [pl("a", "Ann", "EXCELLENT"), pl("b", "Bo", "VERY_GOOD")] },
  { teamNumber: 2, players: [pl("c", "Cy", "GOOD"), pl("d", "Di", "FAIR")] },
];
const render = (sportDef = other, ts = teams) => {
  const config = resolveBalanceConfig(sportDef, undefined);
  return renderToStaticMarkup(
    createElement(BalanceIntelligence, {
      analysis: analyzeTeams(sportDef, config, ts),
      metrics: evaluateTeams(sportDef, config, ts),
      teams: ts,
      sport: sportClientView(sportDef),
      applying: false,
      onApplySwap: () => {},
    })
  );
};

describe("Balance Intelligence panel (admin preview)", () => {
  it("shows quality, facts and the suggested swap with names and Close/Even transition", () => {
    const html = render();
    expect(html).toContain("Balance");
    expect(html).toContain("Uneven");
    expect(html).toContain("The teams have a noticeable strength difference.");
    expect(html).toContain("Suggested improvement");
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
    expect(text).toContain("Swap Ann X (Team 1) with Cy X (Team 2)");
    expect(text).toContain("Uneven → Even");
    expect(html).toContain("Apply Swap");
    expect(html).toContain("Details");
    expect(html).not.toMatch(/points? = |skill level|AI|Telegram|Publish/);
  });

  it("no swap section when teams are already even; sport labels in details", () => {
    const even = [
      { teamNumber: 1, players: [pl("a", "Ann", "GOOD", "SETTER"), pl("b", "Bo", "GOOD", "HITTER")] },
      { teamNumber: 2, players: [pl("c", "Cy", "GOOD", "HITTER"), pl("d", "Di", "GOOD", "ALL_AROUND")] },
    ];
    const html = render(vb, even);
    expect(html).toContain("Even");
    expect(html).not.toContain("Apply Swap");
    expect(html).toContain("1 Setter available for 2 teams.");
    expect(html).toContain("Setters: 1 of 2 teams covered (best possible with this roster: 1)");
    expect(html).not.toMatch(/goal ?keeper/i);
  });

  it("helpers: labels, swap names, and a request body with ids only", () => {
    expect(QUALITY_LABEL).toEqual({ EVEN: "Even", CLOSE: "Close", UNEVEN: "Uneven" });
    const analysis = analyzeTeams(other, resolveBalanceConfig(other, undefined), teams);
    expect(describeSwap(analysis, teams)).toEqual({ nameA: "Ann X", teamA: 1, nameB: "Cy X", teamB: 2, from: "Uneven", to: "Even" });
    expect(applySwapBody(teams, analysis)).toEqual({
      teams: [{ teamNumber: 1, playerIds: ["a", "b"] }, { teamNumber: 2, playerIds: ["c", "d"] }],
      swap: { playerA: "a", playerB: "c" },
    });
  });

  it("Apply Swap in the Generate section only calls the swap endpoint (never publish/Telegram)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalGenerateSection.tsx"), "utf8");
    const fn = src.slice(src.indexOf("async function applySuggestedSwap"), src.indexOf("async function publish"));
    expect(fn).toContain('path: "/generate/swap"');
    expect(fn).not.toMatch(/\/publish|telegram|close-and-post/i);
  });
});
