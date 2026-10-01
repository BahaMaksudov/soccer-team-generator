import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ANALYSIS_VERSION,
  METRICS_VERSION,
  MIN_SWAP_IMPROVEMENT,
  QUALITY_THRESHOLDS,
  analyzeTeams,
  applySwap,
  buildStoredMetrics,
  classifyQuality,
  isMaterialImprovement,
  parseStoredMetrics,
} from "@/lib/balanceAnalysis";
import { generateTeams, resolveBalanceConfig, type EnginePlayer } from "@/lib/balanceEngine";
import { findSport, type SportDefinition } from "@/lib/sports";

const sport = (k: string) => findSport(k)!;
const cfg = (s: SportDefinition) => resolveBalanceConfig(s, undefined);
let n = 0;
const P = (position: string, rating = "GOOD", stamina = 3): EnginePlayer => ({ id: `p${++n}`, position, rating, stamina });
const T = (...teams: EnginePlayer[][]) => teams.map((players, i) => ({ teamNumber: i + 1, players }));
const analyze = (k: string, teams: ReturnType<typeof T>) => analyzeTeams(sport(k), cfg(sport(k)), teams);
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("quality levels and materiality (M8-v1 constants)", () => {
  it("thresholds: <4 EVEN, 4–9 CLOSE, ≥10 UNEVEN (boundaries 3, 4, 9, 10)", () => {
    expect(QUALITY_THRESHOLDS).toEqual({ evenBelow: 4, unevenFrom: 10 });
    expect([0, 3, 3.999, 4, 9, 9.5, 10, 40].map(classifyQuality)).toEqual(["EVEN", "EVEN", "EVEN", "CLOSE", "CLOSE", "CLOSE", "UNEVEN", "UNEVEN"]);
  });

  it("a swap is material only with ≥5 improvement AND a better level", () => {
    expect(MIN_SWAP_IMPROVEMENT).toBe(5);
    expect(isMaterialImprovement(10, 5)).toBe(true); // UNEVEN → CLOSE
    expect(isMaterialImprovement(12, 3)).toBe(true); // UNEVEN → EVEN
    expect(isMaterialImprovement(8, 3)).toBe(true); // CLOSE → EVEN
    expect(isMaterialImprovement(6, 3)).toBe(false); // CLOSE → EVEN but < 5
    expect(isMaterialImprovement(20, 11)).toBe(false); // UNEVEN → UNEVEN
    expect(isMaterialImprovement(9, 4)).toBe(false); // CLOSE → CLOSE
    expect(isMaterialImprovement(3, 0)).toBe(false); // EVEN → EVEN
    expect(isMaterialImprovement(13, 9.5)).toBe(false); // UNEVEN → CLOSE but < 5
  });
});

describe("assignment quality + best single swap", () => {
  // Other: impact = 10×skill + 2×stamina + 2×3  → stamina 3: EXC 52, VG 42, GOOD 32, FAIR 22.
  it("materially uneven teams → deterministic improving swap; applying it gives the promised result", () => {
    const [exc, vg, good, fair] = [P("PLAYER", "EXCELLENT"), P("PLAYER", "VERY_GOOD"), P("PLAYER", "GOOD"), P("PLAYER", "FAIR")];
    const teams = T([exc, vg], [good, fair]);
    const a = analyze("other", teams);
    expect(a).toMatchObject({ analysisVersion: ANALYSIS_VERSION, quality: "UNEVEN", impactSpread: 40, improvable: true, teamSizes: [2, 2] });
    // EXC↔GOOD and VG↔FAIR both reach 0; stable order picks the first.
    expect(a.bestSwap).toEqual({
      teamA: 1, playerA: exc.id, roleA: "PLAYER", teamB: 2, playerB: good.id, roleB: "PLAYER", sameRole: true,
      before: { quality: "UNEVEN", impactSpread: 40 },
      after: { quality: "EVEN", impactSpread: 0, averageSkillSpread: 0, staminaSpread: 0 },
    });
    expect(a.summary).toEqual(["The teams have a noticeable strength difference.", "A single swap can make the teams more even."]);
    const swapped = applySwap(teams, exc.id, good.id)!;
    expect(swapped.map((t) => t.players.length)).toEqual([2, 2]);
    const after = analyze("other", swapped);
    expect(after).toMatchObject({ quality: "EVEN", impactSpread: 0, improvable: false, bestSwap: null });
    expect(after.summary).toEqual(["Teams are evenly matched.", "No change needed."]);
  });

  it("identical input → identical analysis (no randomness)", () => {
    const teams = T([P("PLAYER", "EXCELLENT"), P("PLAYER", "GOOD"), P("PLAYER", "FAIR")], [P("PLAYER", "VERY_GOOD"), P("PLAYER", "FAIR"), P("PLAYER", "FAIR")]);
    expect(JSON.stringify(analyze("other", teams))).toBe(JSON.stringify(analyze("other", teams)));
  });

  it("balanced teams → no suggestion; improvement < 5 or same level → no suggestion", () => {
    expect(analyze("other", T([P("PLAYER", "GOOD"), P("PLAYER", "GOOD")], [P("PLAYER", "GOOD"), P("PLAYER", "GOOD")])).bestSwap).toBeNull();
    // spread 6 (CLOSE, stamina-only differences): the best swap (→ 2) is EVEN but improves by < 5 → no suggestion
    const close = analyze("other", T([P("PLAYER", "GOOD", 5), P("PLAYER", "GOOD", 3)], [P("PLAYER", "GOOD", 1), P("PLAYER", "GOOD", 4)]));
    expect(close).toMatchObject({ quality: "CLOSE", impactSpread: 6, improvable: false, bestSwap: null });
    expect(close.summary.at(-1)).toBe("No single swap would noticeably improve these teams.");
    // UNEVEN → UNEVEN only: 3 teams where one team is unreachable by a single swap
    const stuck = analyze("other", T([P("PLAYER", "EXCELLENT"), P("PLAYER", "EXCELLENT")], [P("PLAYER", "FAIR"), P("PLAYER", "FAIR")], [P("PLAYER", "FAIR"), P("PLAYER", "FAIR")]));
    expect(stuck.quality).toBe("UNEVEN");
    expect(stuck.bestSwap).toBeNull();
  });

  it("CLOSE → EVEN is suggested when the improvement is ≥ 5", () => {
    // stamina-only differences: T1 = 36+36 = 72, T2 = 32+32 = 64 → spread 8 (CLOSE); one swap → 0 (EVEN)
    const a1 = P("PLAYER", "GOOD", 5); // 20+10+6 = 36
    const a2 = P("PLAYER", "GOOD", 5); // 36
    const b1 = P("PLAYER", "GOOD", 3); // 32
    const b2 = P("PLAYER", "GOOD", 3); // 32
    const a = analyze("other", T([a1, a2], [b1, b2]));
    expect(a).toMatchObject({ quality: "CLOSE", impactSpread: 8, improvable: true });
    expect(a.bestSwap?.after).toMatchObject({ quality: "EVEN", impactSpread: 0 });
  });

  it("team sizes never change; uneven sizes are a roster note, not a penalty", () => {
    const teams = T([P("PLAYER"), P("PLAYER"), P("PLAYER", "FAIR")], [P("PLAYER", "EXCELLENT"), P("PLAYER")]);
    const a = analyze("other", teams);
    expect(a.teamSizes).toEqual([3, 2]);
    expect(a.rosterNotes).toContainEqual({ level: "INFO", code: "UNEVEN_TEAM_SIZES", largerTeams: [1] });
    expect(a.summary).toContain("Team 1 has one extra player.");
    if (a.bestSwap) expect(applySwap(teams, a.bestSwap.playerA, a.bestSwap.playerB)!.map((t) => t.players.length)).toEqual([3, 2]);
  });

  it("applySwap refuses same-team or unknown players", () => {
    const teams = T([P("PLAYER"), P("PLAYER")], [P("PLAYER"), P("PLAYER")]);
    expect(applySwap(teams, teams[0].players[0].id, teams[0].players[1].id)).toBeNull();
    expect(applySwap(teams, teams[0].players[0].id, "nope")).toBeNull();
  });
});

describe("role safety and achievable coverage (registry-driven)", () => {
  it("volleyball: a swap that leaves a team without its Setter is rejected even if it balances better", () => {
    // volleyball impact (coef 0.5, stamina 3): 10×skill + 3 + 6 → EXC 49, FAIR 19
    const allExc = P("ALL_AROUND", "EXCELLENT");
    const setterExc = P("SETTER", "EXCELLENT");
    const setterFair = P("SETTER", "FAIR");
    const allFair = P("ALL_AROUND", "FAIR");
    const a = analyze("volleyball", T([allExc, setterExc], [setterFair, allFair]));
    expect(a.roleCoverage).toEqual([{ roleKey: "SETTER", mode: "SPREAD", perTeam: 1, available: 2, covered: 2, achievable: 2, optimal: true }]);
    // allExc↔setterFair (first in order, spread 0) would leave Team 2 without a Setter → rejected.
    expect(a.bestSwap).toMatchObject({ playerA: allExc.id, playerB: allFair.id, sameRole: true, after: { impactSpread: 0 } });
  });

  it("cross-role swaps are allowed when coverage does not drop", () => {
    // Team 1 has two setters, Team 2 none: moving a setter across IMPROVES coverage and is allowed.
    const s1 = P("SETTER", "EXCELLENT");
    const s2 = P("SETTER", "EXCELLENT");
    const x = P("HITTER", "FAIR");
    const y = P("HITTER", "FAIR");
    const a = analyze("volleyball", T([s1, s2], [x, y]));
    expect(a.roleCoverage[0]).toMatchObject({ covered: 1, achievable: 2, optimal: false });
    expect(a.bestSwap).toMatchObject({ roleA: "SETTER", roleB: "HITTER", sameRole: false });
    const after = analyze("volleyball", applySwap(T([s1, s2], [x, y]), a.bestSwap!.playerA, a.bestSwap!.playerB)!);
    expect(after.roleCoverage[0]).toMatchObject({ covered: 2, optimal: true });
  });

  it("roster shortage is not an assignment penalty: 1 Setter / 2 teams is still optimal coverage", () => {
    const a = analyze("volleyball", T([P("SETTER"), P("ALL_AROUND")], [P("ALL_AROUND"), P("ALL_AROUND")]));
    expect(a.roleCoverage[0]).toMatchObject({ available: 1, covered: 1, achievable: 1, optimal: true });
    expect(a.quality).toBe("EVEN");
    expect(a.rosterNotes).toEqual([{ level: "NOTICE", code: "ROLE_SHORTAGE", roleKey: "SETTER", available: 1, needed: 2, teamCount: 2 }]);
    expect(a.summary).toEqual(["Teams are evenly matched.", "1 Setter available for 2 teams.", "No change needed."]);
  });

  it("soccer: goalkeeper coverage protected; shortage is a NOTICE; full coverage is stated", () => {
    const gk1 = P("GOALKEEPER", "EXCELLENT");
    const gk2 = P("GOALKEEPER", "FAIR");
    const teams = T([gk1, P("FORWARD", "EXCELLENT"), P("DEFENDER", "GOOD")], [gk2, P("FORWARD", "FAIR"), P("DEFENDER", "FAIR")]);
    const a = analyze("soccer", teams);
    expect(a.summary).toContain("Each team has a Goalkeeper.");
    if (a.bestSwap) {
      const after = analyze("soccer", applySwap(teams, a.bestSwap.playerA, a.bestSwap.playerB)!);
      expect(after.roleCoverage[0].covered).toBe(2);
    }
    const short = analyze("soccer", T([P("GOALKEEPER"), P("FORWARD")], [P("FORWARD"), P("FORWARD")], [P("FORWARD"), P("DEFENDER")]));
    expect(short.rosterNotes[0]).toMatchObject({ level: "NOTICE", code: "ROLE_SHORTAGE", roleKey: "GOALKEEPER", available: 1, needed: 3 });
    expect(short.summary).toContain("1 Goalkeeper available for 3 teams.");
    expect(short.roleCoverage[0]).toMatchObject({ covered: 1, achievable: 1, optimal: true });
  });

  it("basketball: Big shortage is INFO only; American Football (flag_football): QB shortage is a NOTICE; Other: no role notes", () => {
    const bb = analyze("basketball", T([P("BIG"), P("GUARD")], [P("WING"), P("ANY")]));
    expect(bb.rosterNotes).toEqual([{ level: "INFO", code: "ROLE_SHORTAGE", roleKey: "BIG", available: 1, needed: 2, teamCount: 2 }]);
    expect(bb.summary).toContain("1 Big available for 2 teams.");
    const af = analyze("flag_football", T([P("QUARTERBACK"), P("ATHLETE")], [P("RECEIVER"), P("ATHLETE")], [P("DEFENDER"), P("RUSHER_LINE")]));
    expect(af.rosterNotes[0]).toMatchObject({ level: "NOTICE", roleKey: "QUARTERBACK", available: 1, needed: 3 });
    expect(af.summary).toContain("1 Quarterback available for 3 teams.");
    const other = analyze("other", T([P("PLAYER"), P("PLAYER")], [P("PLAYER"), P("PLAYER")]));
    expect(other.rosterNotes).toEqual([]);
    expect(other.roleCoverage).toEqual([]);
    expect(findSport("american_football")).toBeUndefined();
  });

  it("role wording stays inside its own sport", () => {
    const texts = (k: string, roles: string[]) =>
      JSON.stringify(analyze(k, T(roles.slice(0, 2).map((r) => P(r)), roles.slice(2, 4).map((r) => P(r)))).summary);
    const soccerTxt = texts("soccer", ["GOALKEEPER", "FORWARD", "DEFENDER", "MIDFIELDER"]);
    const bbTxt = texts("basketball", ["GUARD", "WING", "ANY", "GUARD"]);
    const vbTxt = texts("volleyball", ["HITTER", "MIDDLE", "ALL_AROUND", "LIBERO"]);
    const afTxt = texts("flag_football", ["RECEIVER", "ATHLETE", "DEFENDER", "RUSHER_LINE"]);
    const otTxt = texts("other", ["PLAYER", "PLAYER", "PLAYER", "PLAYER"]);
    expect(soccerTxt).toMatch(/Goalkeeper/);
    for (const t of [bbTxt, vbTxt, afTxt, otTxt]) expect(t).not.toMatch(/goal ?keeper/i);
    for (const t of [soccerTxt, bbTxt, afTxt, otTxt]) expect(t).not.toMatch(/setter/i);
    for (const t of [soccerTxt, bbTxt, vbTxt, otTxt]) expect(t).not.toMatch(/quarterback/i);
    expect(vbTxt).toMatch(/0 Setters available for 2 teams/);
    expect(afTxt).toMatch(/0 Quarterbacks available for 2 teams/);
  });

  it("unknown roles are treated as the sport's default role (as in balance-v2) and noted", () => {
    const a = analyze("other", T([P("GOALKEEPER"), P("PLAYER")], [P("PLAYER"), P("PLAYER")]));
    expect(a.rosterNotes).toEqual([{ level: "INFO", code: "UNKNOWN_ROLE", roleKey: "GOALKEEPER", count: 1, treatedAs: "PLAYER" }]);
    expect(a.quality).toBe("EVEN");
  });
});

describe("property: suggestions over generated rosters (all sports)", () => {
  it("suggestions are always material, role-safe, size-preserving and deliver their promised result", () => {
    let suggested = 0;
    for (const k of ["soccer", "basketball", "volleyball", "flag_football", "other"]) {
      const s = sport(k);
      for (let i = 0; i < 300; i++) {
        const r = mulberry32(i * 31 + k.length);
        const teamCount = 2 + Math.floor(r() * 3);
        const players = Array.from({ length: teamCount * 2 + Math.floor(r() * 14) }, () =>
          P(s.roles[Math.floor(r() * s.roles.length)].key, ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"][Math.floor(r() * 4)], 1 + Math.floor(r() * 5))
        );
        const { teams } = generateTeams({ players, teamCount, sport: s, config: cfg(s), rng: r });
        const a = analyzeTeams(s, cfg(s), teams);
        expect(a.quality).toBe(classifyQuality(a.impactSpread));
        if (!a.bestSwap) continue;
        suggested++;
        expect(isMaterialImprovement(a.impactSpread, a.bestSwap.after.impactSpread)).toBe(true);
        const swapped = applySwap(teams, a.bestSwap.playerA, a.bestSwap.playerB)!;
        expect(swapped.map((t) => t.players.length)).toEqual(teams.map((t) => t.players.length));
        const after = analyzeTeams(s, cfg(s), swapped);
        expect(after.impactSpread).toBe(a.bestSwap.after.impactSpread);
        expect(after.quality).toBe(a.bestSwap.after.quality);
        after.roleCoverage.forEach((c, idx) => expect(c.covered).toBeGreaterThanOrEqual(a.roleCoverage[idx].covered));
      }
    }
    expect(suggested).toBeGreaterThan(50); // the feature actually fires on realistic rosters
  });
});

describe("cost: exhaustive single-swap candidate counts", () => {
  it("evaluates exactly the cross-team pairs (12/2→36, 18/3→108, 24/4→216, 30/5→360)", () => {
    for (const [players, teamCount, expected] of [[12, 2, 36], [18, 3, 108], [24, 4, 216], [30, 5, 360]] as const) {
      const per = players / teamCount;
      const teams = Array.from({ length: teamCount }, (_, t) => ({ teamNumber: t + 1, players: Array.from({ length: per }, () => P("PLAYER")) }));
      expect(analyze("other", teams).swapCandidatesEvaluated).toBe(expected);
    }
  });
});

describe("persistence format and legacy tolerance", () => {
  it("stored metrics: metrics-v2 + analysis without swap, ids, names or text", () => {
    const teams = T([{ ...P("SETTER", "EXCELLENT"), firstName: "Ann" } as EnginePlayer], [{ ...P("HITTER", "FAIR"), firstName: "Bo" } as EnginePlayer]);
    const stored = buildStoredMetrics(sport("volleyball"), cfg(sport("volleyball")), teams);
    expect(stored.metricsVersion).toBe(METRICS_VERSION);
    expect(METRICS_VERSION).toBe("metrics-v2");
    expect(stored.analysis.analysisVersion).toBe("balance-analysis-v1");
    expect(Object.keys(stored.analysis).sort()).toEqual(
      ["analysisVersion", "averageSkillSpread", "impactSpread", "improvable", "quality", "relativeImpactSpread", "roleCoverage", "rosterNotes", "staminaSpread", "teamSizes"]
    );
    const json = JSON.stringify(stored);
    expect(json).not.toMatch(/bestSwap|summary|"id"|Ann|Bo|p\d+|firstName|email|telegram|phone|whatsapp|token|session/i);
  });

  it("parses null (pre-M7), M7 (no version) and M8 metrics; never throws on garbage", () => {
    expect(parseStoredMetrics(null)).toEqual({ version: "none" });
    const m7 = JSON.stringify({ teamCount: 2, playerCount: 4, teams: [], sizeSpread: 0 });
    expect(parseStoredMetrics(m7)).toMatchObject({ version: "metrics-v1" });
    const m8 = JSON.stringify(buildStoredMetrics(sport("other"), cfg(sport("other")), T([P("PLAYER")], [P("PLAYER")])));
    expect(parseStoredMetrics(m8)).toMatchObject({ version: "metrics-v2", metrics: { analysis: { quality: "EVEN" } } });
    expect(parseStoredMetrics("{not json")).toEqual({ version: "unreadable" });
    expect(parseStoredMetrics("[]")).toEqual({ version: "unreadable" });
  });
});

describe("the analyzer is registry-driven and self-contained", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/lib/balanceAnalysis.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("names no sport or role", () => {
    expect(src).not.toMatch(/soccer|basketball|volleyball|football|goal ?keeper|setter|quarterback|GOALKEEPER|SETTER|QUARTERBACK|"BIG"|sportKey ===|sport\.key ===/i);
  });
  it("no randomness, I/O, messaging or AI", () => {
    expect(src).not.toMatch(/Math\.random|prisma|fetch\(|telegram|whatsapp|resend|openai|anthropic|gemini|llm/i);
  });
});
