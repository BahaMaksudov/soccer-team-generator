import type { Player, Position } from "@prisma/client";
import { getPlayerImpactScore, type BalanceWeights, type ScorablePlayer } from "@/lib/scoring";

// `format` (6|7|8-a-side) is accepted for backward compatibility with
// existing callers but is not currently used by this algorithm — no
// per-format position quotas etc. exist yet. Left as a known no-op
// pending the multi-sport roster-rules work (see architecture audit,
// §13/§14).
type Format = 6 | 7 | 8;

/**
 * Everything the generator actually needs from a player: enough to
 * score them (ScorablePlayer, from src/lib/scoring.ts), a stable id
 * for dedup/tracking, and a name to carry through to the returned
 * teams for display. Deliberately NOT the full Prisma `Player` —
 * callers should pass only these fields (e.g. via a Prisma `select`),
 * so nothing else on a Player row — Telegram BigInt fields in
 * particular — can end up in a team-generation response. Any object
 * satisfying the full `Player` type already satisfies this narrower
 * one, so this is a non-breaking change for existing callers.
 */
export type GeneratorPlayer = ScorablePlayer & Pick<Player, "id" | "firstName" | "lastName">;

type Team = {
  teamNumber: number;
  players: GeneratorPlayer[];
  score: number;
  capacity: number;
};

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildCapacities(playerCount: number, teamCount: number): number[] {
  const base = Math.floor(playerCount / teamCount);
  const rem = playerCount % teamCount;
  // first 'rem' teams get one extra player
  return Array.from({ length: teamCount }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * Greedy, weakest-team-first balanced team generator.
 *
 * 1) One goalkeeper is assigned to each team (if available), strongest
 *    goalkeepers placed first, always onto the currently-weakest team
 *    with remaining capacity.
 * 2) Every other player (plus any goalkeeper overflow beyond one per
 *    team) is placed the same way, strongest player first.
 *
 * `weights` customizes the impact-score formula (see src/lib/scoring.ts);
 * omitting it uses defaults that reproduce this app's historical behavior.
 *
 * `rng` defaults to Math.random so live generation stays intentionally
 * non-deterministic (re-running "Generate" can produce a different valid
 * split, by design). Tests should pass a seeded rng for reproducibility.
 */
export function generateBalancedTeams(
  players: GeneratorPlayer[],
  teamCount: number,
  format?: Format,
  weights?: BalanceWeights,
  rng: () => number = Math.random
): Array<{ teamNumber: number; players: GeneratorPlayer[] }> {
  if (teamCount < 2) throw new Error("Number of teams must be at least 2.");
  if (players.length < teamCount) throw new Error("Not enough players for that many teams.");

  const capacities = buildCapacities(players.length, teamCount);

  const teams: Team[] = Array.from({ length: teamCount }, (_, i) => ({
    teamNumber: i + 1,
    players: [],
    score: 0,
    capacity: capacities[i],
  }));

  const GOALKEEPER: Position = "GOALKEEPER";

  // ---- Step 1: Assign goalkeepers (1 per team if possible) ----
  const gks = players.filter((p) => p.position === GOALKEEPER);
  const others = players.filter((p) => p.position !== GOALKEEPER);

  if (gks.length > 0) {
    const gkSorted = shuffle(gks, rng).sort(
      (a, b) => getPlayerImpactScore(b, weights) - getPlayerImpactScore(a, weights)
    );

    for (let i = 0; i < Math.min(teamCount, gkSorted.length); i++) {
      const candidates = teams
        .filter((t) => t.players.length < t.capacity)
        .sort((a, b) => a.score - b.score);

      if (candidates.length === 0) break;

      const team = candidates[0];
      const gk = gkSorted[i];

      team.players.push(gk);
      team.score += getPlayerImpactScore(gk, weights);
    }
  }

  const usedIds = new Set(teams.flatMap((t) => t.players.map((p) => p.id)));
  const remaining = [...others, ...gks.filter((gk) => !usedIds.has(gk.id))];

  // ---- Step 2: Distribute remaining strongest-first, respecting capacity ----
  const sorted = shuffle(remaining, rng).sort(
    (a, b) => getPlayerImpactScore(b, weights) - getPlayerImpactScore(a, weights)
  );

  for (const p of sorted) {
    const candidates = teams
      .filter((t) => t.players.length < t.capacity)
      .sort((a, b) => a.score - b.score);

    if (candidates.length === 0) {
      // should never happen if capacities are correct, but safe-guard
      break;
    }

    // if multiple teams tied by score, pick random among the best few
    const minScore = candidates[0].score;
    const best = candidates.filter((t) => t.score === minScore);
    const team = best[Math.floor(rng() * best.length)];

    team.players.push(p);
    team.score += getPlayerImpactScore(p, weights);
  }

  // Strip internal fields before returning
  return teams.map(({ score, capacity, ...t }) => t);
}
