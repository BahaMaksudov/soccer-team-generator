import { describe, it, expect } from "vitest";
import { legacyGenerateBalancedTeams } from "./fixtures/legacyTeamGen";
import type { Player as LegacyPlayer } from "./fixtures/legacyScoring";
import { generateTeams, resolveBalanceConfig } from "@/lib/balanceEngine";
import { soccer } from "@/lib/sports/soccer";

/**
 * M7 — SOCCER PARITY (the production compatibility contract).
 *
 * The M7 engine with the soccer definition must assign players exactly
 * as the frozen pre-M7 generator (fixtures/legacyTeamGen.ts, verbatim
 * from 841853d) for the same roster, team count, stored weights and
 * seeded rng: same teams, same order inside each team, same sizes, same
 * goalkeeper placement. Any difference fails — never "approximately".
 */

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

const RATINGS = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
const OUTFIELD = ["DEFENDER", "MIDFIELDER", "FORWARD"] as const;

type Case = { players: LegacyPlayer[]; teamCount: number; weights: unknown; seed: number; goalkeepers: number };

function makeCase(i: number): Case {
  const r = mulberry32(1_000_003 * (i + 1));
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const teamCount = i % 10 < 5 ? 2 : i % 10 < 8 ? 3 : 2 + Math.floor(r() * 4); // mostly 2/3, some 4–5
  const size = teamCount + Math.floor(r() * (31 - teamCount));
  const goalkeepers = [0, 1, 2, 3, 4, 6][i % 6]; // 0, 1, 2, 3+ goalkeepers
  const players: LegacyPlayer[] = Array.from({ length: size }, (_, n) => ({
    id: `p${i}-${n}`,
    firstName: `F${n}`,
    lastName: `L${n}`,
    position: n < Math.min(goalkeepers, size) ? "GOALKEEPER" : pick(OUTFIELD),
    rating: pick(RATINGS),
    stamina: 1 + Math.floor(r() * 5),
  }));
  // Interleave goalkeepers into the roster (input order matters to the algorithm).
  const shuffled = [...players].sort(() => r() - 0.5);
  // Stored GroupSetting variants: none (production today), defaults, custom, malformed/partial.
  const weights = [
    undefined,
    { staminaCoef: 1, positionWeights: { GOALKEEPER: 2, DEFENDER: 1, MIDFIELDER: 2, FORWARD: 2 } },
    { staminaCoef: 2.5, positionWeights: { DEFENDER: 4, FORWARD: 0 } },
    { staminaCoef: "x", positionWeights: { GOALKEEPER: "bad", MIDFIELDER: 7 } },
    { staminaCoef: 0 },
    { positionWeights: { GOALKEEPER: -3, DEFENDER: 10, MIDFIELDER: 1, FORWARD: 3 } },
  ][i % 6 === 0 ? 0 : Math.floor(r() * 6)];
  return { players: shuffled, teamCount, weights, seed: 7919 * (i + 1), goalkeepers };
}

const ids = (teams: Array<{ teamNumber: number; players: Array<{ id: string }> }>) =>
  teams.map((t) => [t.teamNumber, ...t.players.map((p) => p.id)]);

const CASES = 5000;

describe("M7 soccer parity: new engine ≡ pre-M7 generateBalancedTeams", () => {
  it(`byte-identical team assignment across ${CASES} seeded random soccer rosters`, () => {
    const coverage = { teamCounts: new Set<number>(), goalkeepers: new Set<number>(), ratings: new Set<string>(), positions: new Set<string>(), stamina: new Set<number>(), sizes: new Set<number>() };
    for (let i = 0; i < CASES; i++) {
      const c = makeCase(i);
      const legacy = legacyGenerateBalancedTeams(c.players, c.teamCount, undefined, c.weights as never, mulberry32(c.seed));
      const next = generateTeams({ players: c.players, teamCount: c.teamCount, sport: soccer, config: resolveBalanceConfig(soccer, c.weights), rng: mulberry32(c.seed) });
      const a = JSON.stringify(ids(legacy));
      const b = JSON.stringify(ids(next.teams));
      if (a !== b) throw new Error(`parity mismatch at case ${i}:\nlegacy ${a}\nnew    ${b}`);
      // The returned player objects are the input objects (names/fields carried through untouched).
      expect(next.teams.flatMap((t) => t.players).every((p) => c.players.includes(p))).toBe(true);
      coverage.teamCounts.add(c.teamCount);
      coverage.goalkeepers.add(Math.min(c.goalkeepers, c.players.length));
      coverage.sizes.add(c.players.length);
      for (const p of c.players) {
        coverage.ratings.add(p.rating);
        coverage.positions.add(p.position);
        coverage.stamina.add(p.stamina);
      }
    }
    expect([...coverage.teamCounts].sort()).toEqual([2, 3, 4, 5]);
    expect([...coverage.goalkeepers].sort((a, b) => a - b)).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 6]));
    expect([...coverage.ratings].sort()).toEqual(["EXCELLENT", "FAIR", "GOOD", "VERY_GOOD"]);
    expect([...coverage.positions].sort()).toEqual(["DEFENDER", "FORWARD", "GOALKEEPER", "MIDFIELDER"]);
    expect([...coverage.stamina].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(coverage.sizes.size).toBeGreaterThan(20);
  });

  it("legacy rosters with a non-numeric stamina still match", () => {
    const players = [
      { id: "a", firstName: "A", lastName: "A", position: "GOALKEEPER", rating: "GOOD", stamina: Number.NaN },
      { id: "b", firstName: "B", lastName: "B", position: "DEFENDER", rating: "EXCELLENT", stamina: 9 },
      { id: "c", firstName: "C", lastName: "C", position: "FORWARD", rating: "FAIR", stamina: 0 },
      { id: "d", firstName: "D", lastName: "D", position: "MIDFIELDER", rating: "VERY_GOOD", stamina: 3 },
    ] as LegacyPlayer[];
    for (let seed = 1; seed <= 200; seed++) {
      const legacy = legacyGenerateBalancedTeams(players, 2, undefined, undefined, mulberry32(seed));
      const next = generateTeams({ players, teamCount: 2, sport: soccer, config: resolveBalanceConfig(soccer, undefined), rng: mulberry32(seed) });
      expect(ids(next.teams)).toEqual(ids(legacy));
    }
  });
});
