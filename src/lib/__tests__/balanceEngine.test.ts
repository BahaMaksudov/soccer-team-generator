import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_VERSION, evaluateTeams, generateTeams, resolveBalanceConfig, type EnginePlayer } from "@/lib/balanceEngine";
import { buildGenerationMetadata, buildPublishSnapshot } from "@/lib/publishTeams";
import { findSport, type SportDefinition } from "@/lib/sports";

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
const sport = (k: string) => findSport(k)!;
const RATINGS = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"];
let n = 0;
const P = (position: string, rating = "GOOD", stamina = 3): EnginePlayer & { firstName: string; lastName: string } => {
  n++;
  return { id: `p${n}`, firstName: `F${n}`, lastName: `L${n}`, position, rating, stamina };
};
const run = (s: SportDefinition, players: EnginePlayer[], teamCount: number, seed = 1) =>
  generateTeams({ players, teamCount, sport: s, config: resolveBalanceConfig(s, undefined), rng: mulberry32(seed) });
const roleCount = (team: { players: EnginePlayer[] }, role: string) => team.players.filter((p) => p.position === role).length;

function assertHardConstraints(players: EnginePlayer[], teams: Array<{ players: EnginePlayer[] }>, teamCount: number) {
  expect(teams).toHaveLength(teamCount);
  const ids = teams.flatMap((t) => t.players.map((p) => p.id));
  expect(ids.sort()).toEqual(players.map((p) => p.id).sort()); // no dropped, no duplicates
  const sizes = teams.map((t) => t.players.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
}

describe("hard constraints only", () => {
  it("rejects <2 teams, too few players and duplicates; otherwise always succeeds", () => {
    const s = sport("other");
    expect(() => run(s, [P("PLAYER"), P("PLAYER")], 1)).toThrow(/at least 2/);
    expect(() => run(s, [P("PLAYER")], 2)).toThrow(/Not enough players/);
    const dup = P("PLAYER");
    expect(() => run(s, [dup, dup, P("PLAYER")], 2)).toThrow(/more than once/);
  });

  it("every sport: random rosters always produce valid teams (sizes ±1, nothing dropped)", () => {
    for (const s of ["soccer", "basketball", "volleyball", "flag_football", "other"].map(sport)) {
      for (let i = 0; i < 300; i++) {
        const r = mulberry32(i + 1);
        const teamCount = 2 + Math.floor(r() * 3);
        const players = Array.from({ length: teamCount + Math.floor(r() * 20) }, () =>
          P(s.roles[Math.floor(r() * s.roles.length)].key, RATINGS[Math.floor(r() * 4)], 1 + Math.floor(r() * 5))
        );
        const res = run(s, players, teamCount, i);
        assertHardConstraints(players, res.teams, teamCount);
        expect(res).toMatchObject({ engineVersion: ENGINE_VERSION, sportKey: s.key, sportVersion: s.version });
      }
    }
  });
});

describe("soccer", () => {
  const s = sport("soccer");
  it("SEED: one goalkeeper per team when enough are selected", () => {
    const players = [P("GOALKEEPER"), P("GOALKEEPER", "FAIR"), P("GOALKEEPER", "EXCELLENT"), ...Array.from({ length: 12 }, () => P("MIDFIELDER"))];
    const res = run(s, players, 3);
    expect(res.teams.map((t) => roleCount(t, "GOALKEEPER"))).toEqual([1, 1, 1]);
    expect(res.warnings).toEqual([]);
  });
  it("GK shortage → structured ROLE_SHORTAGE warning, never a failure", () => {
    const players = [P("GOALKEEPER"), P("GOALKEEPER"), ...Array.from({ length: 10 }, () => P("DEFENDER"))];
    const res = run(s, players, 3);
    assertHardConstraints(players, res.teams, 3);
    expect(res.warnings).toEqual([
      { code: "ROLE_SHORTAGE", roleKey: "GOALKEEPER", mode: "SEED", available: 2, needed: 3, perTeam: 1, teamCount: 3, teamsCovered: 2 },
    ]);
  });
  it("no goalkeepers and excess goalkeepers both work", () => {
    expect(run(s, Array.from({ length: 8 }, () => P("FORWARD")), 2).warnings[0]).toMatchObject({ code: "ROLE_SHORTAGE", available: 0 });
    const excess = Array.from({ length: 6 }, () => P("GOALKEEPER"));
    const res = run(s, [...excess, P("DEFENDER"), P("DEFENDER")], 2);
    assertHardConstraints([...excess], res.teams.map((t) => ({ players: t.players.filter((p) => p.position === "GOALKEEPER") })), 2);
    expect(res.warnings).toEqual([]);
  });
});

describe("basketball (no goalkeeper logic; Bigs spread, never required)", () => {
  const s = sport("basketball");
  it("spreads Bigs across teams and never warns about them", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const players = [P("BIG", "EXCELLENT"), P("BIG", "EXCELLENT"), P("BIG", "FAIR"), ...Array.from({ length: 12 }, (_, i) => P(i % 2 ? "GUARD" : "WING"))];
      const res = run(s, players, 3, seed);
      expect(res.teams.map((t) => roleCount(t, "BIG")).sort()).toEqual([1, 1, 1]);
      expect(res.warnings).toEqual([]);
    }
    expect(run(s, [P("BIG"), P("GUARD"), P("WING"), P("ANY")], 2).warnings).toEqual([]); // 1 Big / 2 teams: info only
  });
  it("2 and 3 teams", () => {
    for (const tc of [2, 3]) {
      const players = Array.from({ length: 10 }, (_, i) => P(["GUARD", "WING", "BIG", "ANY"][i % 4]));
      assertHardConstraints(players, run(s, players, tc).teams, tc);
    }
  });
});

describe("volleyball (setters SPREAD; shortage warns)", () => {
  const s = sport("volleyball");
  it("one setter per team when available", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const players = [P("SETTER", "EXCELLENT"), P("SETTER", "FAIR"), ...Array.from({ length: 10 }, (_, i) => P(i % 3 ? "ALL_AROUND" : "HITTER", RATINGS[i % 4]))];
      const res = run(s, players, 2, seed);
      expect(res.teams.map((t) => roleCount(t, "SETTER"))).toEqual([1, 1]);
      expect(res.metrics.ruleCoverage).toEqual([{ roleKey: "SETTER", mode: "SPREAD", perTeam: 1, available: 2, teamsCovered: 2, teamCount: 2 }]);
    }
  });
  it("1 setter for 2 teams → ROLE_SHORTAGE warning; ALL_AROUND works", () => {
    const players = [P("SETTER"), ...Array.from({ length: 7 }, () => P("ALL_AROUND"))];
    const res = run(s, players, 2);
    assertHardConstraints(players, res.teams, 2);
    expect(res.warnings).toEqual([{ code: "ROLE_SHORTAGE", roleKey: "SETTER", mode: "SPREAD", available: 1, needed: 2, perTeam: 1, teamCount: 2, teamsCovered: 1 }]);
    expect(JSON.stringify(res)).not.toMatch(/GOALKEEPER/i);
  });
  it("stamina weighs half as much as in soccer (coefficient 0.5)", () => {
    expect(resolveBalanceConfig(s, undefined).staminaCoef).toBe(0.5);
  });
});

describe("flag football (QB SPREAD; shortage warns)", () => {
  const s = sport("flag_football");
  it("spreads quarterbacks and warns when short; ATHLETE works", () => {
    const players = [P("QUARTERBACK", "EXCELLENT"), ...Array.from({ length: 11 }, (_, i) => P(i % 2 ? "ATHLETE" : "RECEIVER"))];
    const res = run(s, players, 3);
    assertHardConstraints(players, res.teams, 3);
    expect(res.warnings).toEqual([{ code: "ROLE_SHORTAGE", roleKey: "QUARTERBACK", mode: "SPREAD", available: 1, needed: 3, perTeam: 1, teamCount: 3, teamsCovered: 1 }]);
    const two = [P("QUARTERBACK"), P("QUARTERBACK"), P("ATHLETE"), P("ATHLETE"), P("RECEIVER"), P("DEFENDER")];
    expect(run(s, two, 2).teams.map((t) => roleCount(t, "QUARTERBACK"))).toEqual([1, 1]);
  });
});

describe("other (rating + stamina only)", () => {
  const s = sport("other");
  it("no rules, no warnings; skill balanced", () => {
    const players = [...Array.from({ length: 4 }, () => P("PLAYER", "EXCELLENT")), ...Array.from({ length: 4 }, () => P("PLAYER", "FAIR"))];
    const res = run(s, players, 2);
    expect(res.warnings).toEqual([]);
    expect(res.metrics.ruleCoverage).toEqual([]);
    expect(res.metrics.teams.map((t) => t.skillCounts.EXCELLENT)).toEqual([2, 2]);
  });
  it("an unknown/legacy role is balanced as the default role and reported", () => {
    const res = run(s, [P("GOALKEEPER"), P("PLAYER"), P("PLAYER"), P("PLAYER")], 2);
    expect(res.warnings).toEqual([{ code: "UNKNOWN_ROLE", roleKey: "GOALKEEPER", count: 1, treatedAs: "PLAYER" }]);
  });
});

describe("metrics", () => {
  it("universal + role metrics are deterministic aggregates", () => {
    const s = sport("soccer");
    const teams = [
      { teamNumber: 1, players: [P("GOALKEEPER", "GOOD", 3), P("DEFENDER", "EXCELLENT", 5)] },
      { teamNumber: 2, players: [P("FORWARD", "FAIR", 1), P("MIDFIELDER", "VERY_GOOD", 4), P("ANY", "GOOD", 2)] },
    ];
    const m = evaluateTeams(s, resolveBalanceConfig(s, undefined), teams);
    // GK GOOD s3: 20+6+6=32; DEF EXC s5: 40+10+3=53 → 85.  FWD FAIR s1: 10+2+6=18; MID VG s4: 30+8+6=44; ANY GOOD s2: 20+4+6=30 → 92.
    expect(m.teams.map((t) => t.impactTotal)).toEqual([85, 92]);
    expect(m).toMatchObject({ teamCount: 2, playerCount: 5, sizeSpread: 1, impactSpread: 7, relativeImpactSpread: 0.0791 });
    expect(m.teams[0]).toMatchObject({ size: 2, averageSkill: 3, averageStamina: 4, roleCounts: { GOALKEEPER: 1, DEFENDER: 1 }, skillCounts: { FAIR: 0, GOOD: 1, VERY_GOOD: 0, EXCELLENT: 1 } });
    expect(m.ruleCoverage).toEqual([{ roleKey: "GOALKEEPER", mode: "SEED", perTeam: 1, available: 1, teamsCovered: 1, teamCount: 2 }]);
    expect(m.teams.map((t) => t.topPlayers)).toEqual([1, 1]);
  });
});

describe("privacy: metrics and new snapshots never carry identity data", () => {
  const FORBIDDEN = /email|telegram|phone|whatsapp|userId|"id"|firstName|lastName|session|token|p\d+|Leak/i;

  it("metrics from legacy-shaped rows (with Telegram fields) contain only aggregates", () => {
    const s = sport("soccer");
    const legacyRow = { id: "p1", firstName: "Leak", lastName: "Leak", position: "GOALKEEPER", rating: "GOOD", stamina: 3, telegramUserId: "900003", telegramUsername: "leak", email: "x@example.com", phone: "+15550100", userId: "u1" };
    const m = evaluateTeams(s, resolveBalanceConfig(s, undefined), [{ teamNumber: 1, players: [legacyRow] }, { teamNumber: 2, players: [{ ...legacyRow, id: "p2" }] }]);
    expect(JSON.stringify(m)).not.toMatch(FORBIDDEN);
  });

  it("publish snapshot is the allow-list; generation metadata metrics carry no identity", () => {
    const owned = [
      { id: "p1", firstName: "Ann", lastName: "B", position: "SETTER", rating: "GOOD", stamina: 3 },
      { id: "p2", firstName: "Cy", lastName: "D", position: "HITTER", rating: "FAIR", stamina: 2 },
    ];
    const submitted = [
      { teamNumber: 1, players: [{ id: "p1", telegramUserId: "1", email: "e@x", phone: "+1", whatsapp: "w", userId: "u", token: "t" }] },
      { teamNumber: 2, players: [{ id: "p2" }] },
    ];
    const snapshot = buildPublishSnapshot(submitted, owned);
    expect(Object.keys(snapshot[0].players[0]).sort()).toEqual(["firstName", "id", "lastName", "position", "rating", "stamina"]);
    expect(JSON.stringify(snapshot)).not.toMatch(/telegram|email|phone|whatsapp|userId|token/i);
    const meta = buildGenerationMetadata(sport("volleyball"), undefined, snapshot);
    expect(meta).toMatchObject({ sportKey: "volleyball", engineVersion: ENGINE_VERSION });
    expect(meta.metricsJson).not.toMatch(/email|telegram|phone|whatsapp|userId|"id"|firstName|lastName|Ann|Cy|p1|p2|token/i);
  });
});

describe("the generic engine never names a sport-specific role", () => {
  it("balanceEngine.ts contains no goalkeeper/setter/quarterback logic", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/balanceEngine.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/goal ?keeper|setter|quarterback|GOALKEEPER|SETTER|QUARTERBACK|soccer|volleyball|basketball/i);
    expect(src).not.toMatch(/prisma|fetch\(|telegram|whatsapp|openai/i);
  });
});
