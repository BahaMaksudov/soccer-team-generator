import { describe, it, expect } from "vitest";
import {
  distributedRoles,
  evaluateTeams,
  generateTeams,
  impactScore,
  POSITION_SPREAD_TOLERANCE,
  resolveBalanceConfig,
  roleDistributionPenalty,
  roleExcess,
  type EnginePlayer,
} from "@/lib/balanceEngine";
import { findSport, type SportDefinition } from "@/lib/sports";
import { soccer } from "@/lib/sports/soccer";

/**
 * M8.1 — position-aware balancing. The deterministic engine stays
 * authoritative; a final step spreads every distributable role as evenly as
 * the roster allows, within a bounded skill (impact-spread) budget.
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
type P = EnginePlayer & { firstName: string; lastName: string };

/** A roster with exact role counts and seeded ratings/stamina. */
function roster(roles: Record<string, number>, seed: number): P[] {
  const r = mulberry32(seed);
  const out: P[] = [];
  for (const [position, n] of Object.entries(roles)) for (let i = 0; i < n; i++) out.push({ id: `${position}-${i}`, firstName: position, lastName: `${i}`, position, rating: RATINGS[Math.floor(r() * 4)], stamina: 1 + Math.floor(r() * 5) });
  return out.sort(() => r() - 0.5);
}

const gen = (sport: SportDefinition, players: P[], teamCount: number, seed: number, balanceRoles = true) =>
  generateTeams({ players, teamCount, sport, config: resolveBalanceConfig(sport, undefined), rng: mulberry32(seed), balanceRoles });
/** The pre-M8.1 split: the same engine and rng without the position step. */
const greedy = (sport: SportDefinition, players: P[], teamCount: number, seed: number) => gen(sport, players, teamCount, seed, false);
const counts = (teams: Array<{ players: EnginePlayer[] }>, role: string) => teams.map((t) => t.players.filter((p) => p.position === role).length);
const sorted = (xs: number[]) => [...xs].sort((a, b) => b - a).join("/");
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("roleExcess — distance from the most even split", () => {
  it.each([
    [[2, 1, 1], 0],
    [[2, 0, 2], 1],
    [[2, 2, 0], 1],
    [[3, 1, 0], 2],
    [[1, 1, 1], 0],
    [[2, 1, 0], 2],
    [[1, 1, 0], 0],
    [[2, 0, 0], 1],
    [[1, 0, 0], 0],
    [[0, 0, 0], 0],
  ])("%j → %i", (perTeam, excess) => {
    expect(roleExcess(perTeam)).toBe(excess);
  });
  it("roles come from the sport definition: the generic default role is never distributed", () => {
    expect(distributedRoles(soccer, soccer)).toEqual(["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"]);
    expect(distributedRoles(findSport("volleyball")!, findSport("volleyball")!)).toEqual(["SETTER", "HITTER", "MIDDLE", "LIBERO"]);
    expect(distributedRoles(findSport("other")!, findSport("other")!)).toEqual([]);
    // An IGNORE rule opts its role out.
    expect(distributedRoles(soccer, { roleRules: [{ roleKey: "DEFENDER", perTeam: 1, mode: "IGNORE", warnWhenShort: false }] })).not.toContain("DEFENDER");
  });
});

describe("the real case: soccer, 18 players, 3 teams, 4 defenders", () => {
  // A realistic 18-player soccer roster (3 goalkeepers, 4 defenders) for which the
  // pre-M8.1 generator produces the production 2 / 0 / 2 defender split.
  const config = resolveBalanceConfig(soccer, undefined);
  const found = SEEDS.map((s) => ({ s, players: roster({ GOALKEEPER: 3, DEFENDER: 4, MIDFIELDER: 6, FORWARD: 4, ANY: 1 }, 2026 + s) })).find(({ s, players }) => {
    const c = counts(greedy(soccer, players, 3, s).teams, "DEFENDER");
    return c[1] === 0 && c[0] === 2 && c[2] === 2;
  })!;
  const { s: seed, players } = found ?? { s: 0, players: [] };

  it("BEFORE (pre-M8.1 split, same engine without the position step): 2 / 0 / 2", () => {
    expect(found).toBeDefined();
    expect(counts(greedy(soccer, players, 3, seed).teams, "DEFENDER")).toEqual([2, 0, 2]);
  });
  it("AFTER: the same roster and rng give 2 / 1 / 1 — every team has a defender — within the skill budget", () => {
    const before = greedy(soccer, players, 3, seed).teams;
    const after = generateTeams({ players, teamCount: 3, sport: soccer, config, rng: mulberry32(seed) });
    expect(sorted(counts(after.teams, "DEFENDER"))).toBe("2/1/1");
    expect(counts(after.teams, "GOALKEEPER")).toEqual([1, 1, 1]);
    expect(after.teams.map((t) => t.players.length)).toEqual([6, 6, 6]);
    const b = evaluateTeams(soccer, config, before);
    const mean = b.teams.reduce((n, t) => n + t.impactTotal, 0) / 3;
    expect(after.metrics.impactSpread).toBeLessThanOrEqual(Math.max(b.impactSpread, POSITION_SPREAD_TOLERANCE * mean) + 1e-9);
    // Exposed in the existing metrics (aggregates only).
    expect(after.metrics.roleDistribution?.find((d) => d.roleKey === "DEFENDER")).toMatchObject({ available: 4, excess: 0 });
  });
  it("across 300 rosters of this class, no team is left without a defender unless the skill budget forbids it (≥ 98%)", () => {
    let ok = 0;
    for (const s of SEEDS) if (!counts(gen(soccer, roster({ GOALKEEPER: 3, DEFENDER: 4, MIDFIELDER: 6, FORWARD: 4, ANY: 1 }, s * 13), 3, s).teams, "DEFENDER").includes(0)) ok++;
    expect(ok / SEEDS.length).toBeGreaterThanOrEqual(0.98);
  });
});

describe("soccer defenders and goalkeepers over 3 teams", () => {
  const build = (gk: number, def: number, seed: number) => roster({ GOALKEEPER: gk, DEFENDER: def, MIDFIELDER: 5, FORWARD: 5, ANY: 15 - gk - def - 10 + 3 }, seed);
  it("3 defenders → 1 / 1 / 1 (every roster)", () => {
    for (const s of SEEDS) expect(sorted(counts(gen(soccer, build(3, 3, s), 3, s).teams, "DEFENDER"))).toBe("1/1/1");
  });
  it("2 defenders → 1 / 1 / 0; 1 defender → 1 / 0 / 0 (unavoidable); 0 → nothing to spread", () => {
    for (const s of SEEDS.slice(0, 100)) {
      expect(sorted(counts(gen(soccer, build(3, 2, s), 3, s).teams, "DEFENDER"))).toBe("1/1/0");
      expect(sorted(counts(gen(soccer, build(3, 1, s), 3, s).teams, "DEFENDER"))).toBe("1/0/0");
      const none = gen(soccer, build(3, 0, s), 3, s);
      expect(none.metrics.roleDistribution?.some((d) => d.roleKey === "DEFENDER")).toBe(false);
    }
  });
  it("goalkeepers ≥ teams → one per team; fewer → spread, never invented, never failing (SEED unchanged)", () => {
    for (const s of SEEDS.slice(0, 100)) {
      expect(counts(gen(soccer, build(3, 3, s), 3, s).teams, "GOALKEEPER")).toEqual([1, 1, 1]);
      expect(sorted(counts(gen(soccer, build(4, 3, s), 3, s).teams, "GOALKEEPER"))).toBe("2/1/1");
      expect(sorted(counts(gen(soccer, build(2, 3, s), 3, s).teams, "GOALKEEPER"))).toBe("1/1/0");
      const short = gen(soccer, build(1, 3, s), 3, s);
      expect(sorted(counts(short.teams, "GOALKEEPER"))).toBe("1/0/0");
      expect(short.warnings.some((w) => w.code === "ROLE_SHORTAGE")).toBe(true);
    }
  });
});

describe("skill balance is never traded away for positions", () => {
  it("never above max(greedy spread, 5% of mean team impact) — and an unfixable roster is left as the greedy split", () => {
    let leftAlone = 0;
    for (let s = 1; s <= 400; s++) {
      const players = roster({ GOALKEEPER: 2, DEFENDER: 4, MIDFIELDER: 5, FORWARD: 4, ANY: 2 }, s * 31);
      const config = resolveBalanceConfig(soccer, undefined);
      const before = greedy(soccer, players, 3, s).teams;
      const after = gen(soccer, players, 3, s);
      const b = evaluateTeams(soccer, config, before);
      const mean = b.teams.reduce((n, t) => n + t.impactTotal, 0) / 3;
      const budget = Math.max(b.impactSpread, POSITION_SPREAD_TOLERANCE * mean) + 1e-6;
      expect(after.metrics.impactSpread).toBeLessThanOrEqual(budget);
      if (roleDistributionPenalty(soccer, config, before) > 0 && JSON.stringify(after.teams.map((t) => t.players.map((p) => p.id))) === JSON.stringify(before.map((t) => t.players.map((p) => p.id)))) {
        // Left alone: then EVERY single swap that would spread roles better busts the skill budget.
        leftAlone++;
        const score = (p: EnginePlayer) => impactScore(soccer, config, p);
        const totals = before.map((t) => t.players.reduce((n, p) => n + score(p), 0));
        const p0 = roleDistributionPenalty(soccer, config, before);
        for (let a = 0; a < 3; a++)
          for (let c = a + 1; c < 3; c++)
            for (const x of before[a].players)
              for (const y of before[c].players) {
                const swapped = before.map((t, k) => ({ players: t.players.map((p) => (k === a && p === x ? y : k === c && p === y ? x : p)) }));
                if (roleDistributionPenalty(soccer, config, swapped) >= p0) continue;
                const t2 = [...totals];
                t2[a] += score(y) - score(x);
                t2[c] += score(x) - score(y);
                expect(Math.max(...t2) - Math.min(...t2)).toBeGreaterThan(budget - 2e-6);
              }
      }
    }
    expect(leftAlone).toBeLessThan(40); // rare: almost every concentrated split is fixable within the budget
  });
});

describe("deterministic", () => {
  it("identical input + configuration + rng → identical teams; the balancing step itself uses no randomness", () => {
    for (const s of SEEDS.slice(0, 50)) {
      const players = roster({ GOALKEEPER: 3, DEFENDER: 4, MIDFIELDER: 6, FORWARD: 4, ANY: 1 }, s);
      const a = gen(soccer, players, 3, s);
      const b = gen(soccer, players, 3, s);
      expect(b.teams.map((t) => t.players.map((p) => p.id))).toEqual(a.teams.map((t) => t.players.map((p) => p.id)));
      expect(b.metrics).toEqual(a.metrics);
    }
  });
});

describe("sport-aware, not soccer-specific", () => {
  const excess = (r: { metrics: { roleDistribution?: Array<{ excess: number }> } }) => (r.metrics.roleDistribution ?? []).reduce((n, d) => n + d.excess, 0);
  /** Rule role always one per team; every role as even as possible in ≥ 90% of rosters; never less even than before. */
  function check(key: string, roles: Record<string, number>, teamCount: number, ruleRole: string) {
    const sport = findSport(key)!;
    let even = 0;
    for (const s of SEEDS) {
      const players = roster(roles, s * 7);
      const before = greedy(sport, players, teamCount, s);
      const after = gen(sport, players, teamCount, s);
      expect(counts(after.teams, ruleRole)).toEqual(Array(teamCount).fill(roles[ruleRole] / teamCount));
      expect(excess(after)).toBeLessThanOrEqual(excess(before));
      if (excess(after) === 0) even++;
    }
    return even / SEEDS.length;
  }
  it("basketball: Bigs one per team (SPREAD rule); Guards and Wings spread too; Any is flexible", () => {
    expect(check("basketball", { GUARD: 4, WING: 3, BIG: 3, ANY: 5 }, 3, "BIG")).toBeGreaterThanOrEqual(0.9);
  });
  it("volleyball: setters one per team; hitters / middles / liberos spread; All-around exempt", () => {
    expect(check("volleyball", { SETTER: 2, HITTER: 4, MIDDLE: 2, LIBERO: 2, ALL_AROUND: 2 }, 2, "SETTER")).toBeGreaterThanOrEqual(0.9);
  });
  it("American football: quarterbacks one per team; receivers / rushers / defenders spread", () => {
    expect(check("flag_football", { QUARTERBACK: 3, RECEIVER: 4, RUSHER_LINE: 3, DEFENDER: 5, ATHLETE: 3 }, 3, "QUARTERBACK")).toBeGreaterThanOrEqual(0.9);
  });
  it("Other (one generic role): nothing to spread — the greedy split is returned unchanged", () => {
    const other = findSport("other")!;
    for (const s of SEEDS.slice(0, 50)) {
      const players = roster({ PLAYER: 13 }, s);
      const config = resolveBalanceConfig(other, undefined);
      expect(roleDistributionPenalty(other, config, gen(other, players, 3, s).teams)).toBe(0);
      expect(gen(other, players, 3, s).metrics.roleDistribution).toEqual([]);
    }
  });
});
