import { describe, it, expect } from "vitest";
import type { Player } from "@prisma/client";
import { generateBalancedTeams } from "../teamGen";
import { getPlayerImpactScore } from "../scoring";

let idCounter = 0;
function makePlayer(overrides: Partial<Player> = {}): Player {
  idCounter += 1;
  return {
    id: overrides.id ?? `p${idCounter}`,
    firstName: overrides.firstName ?? `First${idCounter}`,
    lastName: overrides.lastName ?? `Last${idCounter}`,
    position: overrides.position ?? "MIDFIELDER",
    rating: overrides.rating ?? "GOOD",
    stamina: overrides.stamina ?? 3,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    telegramUserId: overrides.telegramUserId ?? null,
    telegramUsername: overrides.telegramUsername ?? null,
    telegramFirst: overrides.telegramFirst ?? null,
    telegramLast: overrides.telegramLast ?? null,
  } as Player;
}

/** Small deterministic PRNG so tests never depend on Math.random. */
function seededRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function totalPlayers(teams: ReturnType<typeof generateBalancedTeams>) {
  return teams.reduce((n, t) => n + t.players.length, 0);
}

function idsOf(teams: ReturnType<typeof generateBalancedTeams>) {
  return teams.flatMap((t) => t.players.map((p) => p.id));
}

describe("generateBalancedTeams — normal generation", () => {
  it("splits a normal roster into 2 teams with no dropped/duplicated players", () => {
    const players = Array.from({ length: 12 }, (_, i) =>
      makePlayer({ position: i % 4 === 0 ? "GOALKEEPER" : "MIDFIELDER" })
    );
    const teams = generateBalancedTeams(players, 2, undefined, undefined, seededRng(1));
    expect(teams).toHaveLength(2);
    expect(totalPlayers(teams)).toBe(12);
    expect(new Set(idsOf(teams)).size).toBe(12);
  });

  it("splits a roster into 3+ teams with no dropped/duplicated players", () => {
    const players = Array.from({ length: 17 }, () => makePlayer());
    const teams = generateBalancedTeams(players, 4, undefined, undefined, seededRng(2));
    expect(teams).toHaveLength(4);
    expect(totalPlayers(teams)).toBe(17);
    expect(new Set(idsOf(teams)).size).toBe(17);
  });
});

describe("generateBalancedTeams — capacity", () => {
  it("distributes an uneven player count with at most a 1-player spread", () => {
    const players = Array.from({ length: 13 }, () => makePlayer());
    const teams = generateBalancedTeams(players, 2, undefined, undefined, seededRng(3));
    const sizes = teams.map((t) => t.players.length).sort((a, b) => a - b);
    expect(sizes).toEqual([6, 7]);
  });

  it("resulting total player count always equals the input count, across many team counts", () => {
    for (const teamCount of [2, 3, 5]) {
      const players = Array.from({ length: 23 }, () => makePlayer());
      const teams = generateBalancedTeams(players, teamCount, undefined, undefined, seededRng(teamCount));
      expect(totalPlayers(teams)).toBe(23);
      expect(new Set(idsOf(teams)).size).toBe(23);
    }
  });
});

describe("generateBalancedTeams — invalid team count", () => {
  it("throws when team count is fewer than 2", () => {
    const players = [makePlayer(), makePlayer()];
    expect(() => generateBalancedTeams(players, 1)).toThrow(/at least 2/i);
  });

  it("throws when there are fewer players than teams", () => {
    const players = [makePlayer(), makePlayer()];
    expect(() => generateBalancedTeams(players, 3)).toThrow(/not enough players/i);
  });
});

describe("generateBalancedTeams — goalkeepers", () => {
  it("handles zero goalkeepers without crashing or dropping players", () => {
    const players = Array.from({ length: 10 }, () => makePlayer({ position: "DEFENDER" }));
    const teams = generateBalancedTeams(players, 2, undefined, undefined, seededRng(4));
    expect(totalPlayers(teams)).toBe(10);
    const gkCount = teams.flatMap((t) => t.players).filter((p) => p.position === "GOALKEEPER").length;
    expect(gkCount).toBe(0);
  });

  it("gives each team exactly one goalkeeper when supply allows", () => {
    const gks = Array.from({ length: 3 }, () => makePlayer({ position: "GOALKEEPER" }));
    const others = Array.from({ length: 9 }, () => makePlayer({ position: "MIDFIELDER" }));
    const teams = generateBalancedTeams([...gks, ...others], 3, undefined, undefined, seededRng(5));
    for (const t of teams) {
      expect(t.players.filter((p) => p.position === "GOALKEEPER").length).toBe(1);
    }
  });

  it("does not drop overflow goalkeepers beyond one per team", () => {
    const gks = Array.from({ length: 5 }, () => makePlayer({ position: "GOALKEEPER" }));
    const others = Array.from({ length: 7 }, () => makePlayer({ position: "MIDFIELDER" }));
    const teams = generateBalancedTeams([...gks, ...others], 2, undefined, undefined, seededRng(6));
    expect(totalPlayers(teams)).toBe(12);
    const gkCount = teams.flatMap((t) => t.players).filter((p) => p.position === "GOALKEEPER").length;
    expect(gkCount).toBe(5);
  });
});

describe("generateBalancedTeams — player state", () => {
  it("does not itself filter by isActive — filtering is the caller's responsibility (see generate/route.ts)", () => {
    const players = [makePlayer({ isActive: false }), makePlayer(), makePlayer()];
    const teams = generateBalancedTeams(players, 2, undefined, undefined, seededRng(11));
    expect(totalPlayers(teams)).toBe(3);
  });

  it("does not crash when a player has a non-numeric/missing stamina value", () => {
    const players = [
      makePlayer({ stamina: undefined as unknown as number }),
      makePlayer({ stamina: Number.NaN as unknown as number }),
      makePlayer(),
      makePlayer(),
    ];
    expect(() =>
      generateBalancedTeams(players, 2, undefined, undefined, seededRng(12))
    ).not.toThrow();
  });
});

describe("generateBalancedTeams — skill spread", () => {
  it("produces valid, capacity-correct teams with extreme skill differences", () => {
    const strong = Array.from({ length: 6 }, () => makePlayer({ rating: "EXCELLENT", stamina: 5 }));
    const weak = Array.from({ length: 6 }, () => makePlayer({ rating: "FAIR", stamina: 1 }));
    const teams = generateBalancedTeams([...strong, ...weak], 2, undefined, undefined, seededRng(7));
    expect(totalPlayers(teams)).toBe(12);
    expect(teams[0].players.length).toBe(teams[1].players.length);
  });
});

describe("generateBalancedTeams — determinism (test-only)", () => {
  it("same players + same weights + same seed => identical output", () => {
    const players = Array.from({ length: 11 }, (_, i) =>
      makePlayer({ id: `d${i}`, rating: i % 2 === 0 ? "GOOD" : "VERY_GOOD" })
    );
    const a = generateBalancedTeams(players, 2, undefined, undefined, seededRng(42));
    const b = generateBalancedTeams(players, 2, undefined, undefined, seededRng(42));
    expect(idsOf(a)).toEqual(idsOf(b));
  });

  it("repeated generation with an unseeded rng can differ (live-UX randomness is preserved)", () => {
    // Not asserting a specific outcome — just documenting that the
    // production default (Math.random) is still what's used when no
    // rng is supplied, matching the existing "regenerate for a
    // different valid split" UX.
    const players = Array.from({ length: 11 }, () => makePlayer());
    expect(() => generateBalancedTeams(players, 2)).not.toThrow();
  });
});

describe("generateBalancedTeams — REGRESSION: balance weights are actually used", () => {
  it("scoring.ts: a custom positionWeights value changes a player's impact score", () => {
    const player = makePlayer({ position: "DEFENDER", rating: "GOOD", stamina: 3 });
    const defaultScore = getPlayerImpactScore(player);
    const customScore = getPlayerImpactScore(player, { positionWeights: { DEFENDER: 50 } });
    expect(customScore).not.toBe(defaultScore);
    expect(customScore).toBeGreaterThan(defaultScore);
  });

  it("generateBalancedTeams: an exaggerated DEFENDER weight measurably changes team assignment", () => {
    // Previously `weights` was accepted but silently ignored by the
    // generator. With DEFENDER weight inflated far above every other
    // signal, the two defenders become the strongest players on the
    // roster and the greedy weakest-team-first rule must place them on
    // different teams — this fails against the old, disconnected code.
    const players = [
      makePlayer({ id: "gk1", position: "GOALKEEPER" }),
      makePlayer({ id: "gk2", position: "GOALKEEPER" }),
      makePlayer({ id: "def1", position: "DEFENDER" }),
      makePlayer({ id: "def2", position: "DEFENDER" }),
      makePlayer({ id: "mid1", position: "MIDFIELDER" }),
      makePlayer({ id: "mid2", position: "MIDFIELDER" }),
    ];

    const teams = generateBalancedTeams(
      players,
      2,
      undefined,
      { positionWeights: { DEFENDER: 1000 } },
      seededRng(9)
    );

    const defendersPerTeam = teams
      .map((t) => t.players.filter((p) => p.position === "DEFENDER").length)
      .sort();
    expect(defendersPerTeam).toEqual([1, 1]);
  });
});
