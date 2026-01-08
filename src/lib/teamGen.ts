// import type { Player, Rating, Position } from "@prisma/client";
// type Team = { teamNumber: number; players: Player[] };
// const ratingWeight: Record<Rating, number> = {
//  FAIR: 1,
//  GOOD: 2,
//  VERY_GOOD: 3,
//  EXCELLENT: 4,
// };
// type BalanceWeights = {
//  staminaCoef?: number;
//  positionWeights?: Record<Position, number>;
//  fairnessWeights?: {
//    totalImpact?: number;
//    gkImpact?: number;
//    defImpact?: number;
//    midImpact?: number;
//    fwdImpact?: number;
//    topCount?: number;
//  };
//  optimizer?: {
//    iterations?: number;
//    samePositionSwapBias?: number; // 0..1
//  };
// };
// const DEFAULT_WEIGHTS: Required<BalanceWeights> = {
//  staminaCoef: 0.5,
//  positionWeights: {
//    GOALKEEPER: 1.0,
//    DEFENDER: 1.05,
//    MIDFIELDER: 1.15,
//    FORWARD: 1.1,
//  },
//  fairnessWeights: {
//    totalImpact: 3.0,
//    gkImpact: 2.0,
//    defImpact: 1.5,
//    midImpact: 1.5,
//    fwdImpact: 1.5,
//    topCount: 1.0,
//  },
//  optimizer: {
//    iterations: 400,
//    samePositionSwapBias: 0.7,
//  },
// };
// function mergedWeights(w?: BalanceWeights): Required<BalanceWeights> {
//  return {
//    ...DEFAULT_WEIGHTS,
//    ...w,
//    positionWeights: { ...DEFAULT_WEIGHTS.positionWeights, ...(w?.positionWeights ?? {}) } as any,
//    fairnessWeights: { ...DEFAULT_WEIGHTS.fairnessWeights, ...(w?.fairnessWeights ?? {}) },
//    optimizer: { ...DEFAULT_WEIGHTS.optimizer, ...(w?.optimizer ?? {}) },
//  };
// }
// function shuffle<T>(arr: T[]) {
//  const a = [...arr];
//  for (let i = a.length - 1; i > 0; i--) {
//    const j = Math.floor(Math.random() * (i + 1));
//    [a[i], a[j]] = [a[j], a[i]];
//  }
//  return a;
// }
// function clamp(n: number, min: number, max: number) {
//  return Math.max(min, Math.min(max, n));
// }
// function staminaValue(p: any) {
//  // p.stamina exists after you add it; fallback to 3
//  return clamp(Number(p?.stamina ?? 3), 1, 5);
// }
// function playerImpact(p: Player, W: Required<BalanceWeights>) {
//  const base = ratingWeight[p.rating] + W.staminaCoef * staminaValue(p);
//  const posW = W.positionWeights[p.position] ?? 1;
//  return base * posW;
// }
// function teamTotals(team: Team, W: Required<BalanceWeights>) {
//  let total = 0;
//  let gk = 0,
//    def = 0,
//    mid = 0,
//    fwd = 0;
//  let top = 0;
//  for (const p of team.players) {
//    const imp = playerImpact(p, W);
//    total += imp;
//    if (p.position === "GOALKEEPER") gk += imp;
//    if (p.position === "DEFENDER") def += imp;
//    if (p.position === "MIDFIELDER") mid += imp;
//    if (p.position === "FORWARD") fwd += imp;
//    if (p.rating === "EXCELLENT") top += 1;
//  }
//  return { total, gk, def, mid, fwd, top };
// }
// function spread(values: number[]) {
//  if (values.length === 0) return 0;
//  let mn = values[0],
//    mx = values[0];
//  for (const v of values) {
//    if (v < mn) mn = v;
//    if (v > mx) mx = v;
//  }
//  return mx - mn;
// }
// function fairnessScore(teams: Team[], W: Required<BalanceWeights>) {
//  const totals = teams.map((t) => teamTotals(t, W));
//  const fw = W.fairnessWeights;
//  const totalSpread = spread(totals.map((x) => x.total));
//  const gkSpread = spread(totals.map((x) => x.gk));
//  const defSpread = spread(totals.map((x) => x.def));
//  const midSpread = spread(totals.map((x) => x.mid));
//  const fwdSpread = spread(totals.map((x) => x.fwd));
//  const topSpread = spread(totals.map((x) => x.top));
//  return (
//    (fw.totalImpact ?? 0) * totalSpread +
//    (fw.gkImpact ?? 0) * gkSpread +
//    (fw.defImpact ?? 0) * defSpread +
//    (fw.midImpact ?? 0) * midSpread +
//    (fw.fwdImpact ?? 0) * fwdSpread +
//    (fw.topCount ?? 0) * topSpread
//  );
// }
// // snake index sequence: 0..T-1 then T-1..0 (repeat)
// function snakePickIndex(i: number, teamCount: number) {
//  const period = teamCount * 2 - 2;
//  if (period <= 0) return 0;
//  const x = i % period;
//  return x < teamCount ? x : period - x;
// }
// // assign required players per team for a given pool
// function assignQuotaSnake(teams: Team[], pool: Player[], perTeam: number, teamCount: number) {
//  let assigned = 0;
//  const needTotal = perTeam * teamCount;
//  // sorted by strongest first (rating + stamina influence happens later; here rating order is good)
//  const sorted = shuffle(pool).sort((a, b) => ratingWeight[b.rating] - ratingWeight[a.rating]);
//  while (assigned < needTotal && sorted.length > 0) {
//    const idx = snakePickIndex(assigned, teamCount);
//    teams[idx].players.push(sorted.shift()!);
//    assigned++;
//  }
//  // return remaining pool not assigned
//  return sorted;
// }
// function teamStrength(team: Team, W: Required<BalanceWeights>) {
//  return team.players.reduce((s, p) => s + playerImpact(p, W), 0);
// }
// export function generateBalancedTeams(
//  players: Player[],
//  teamCount: number,
//  format: 6| 7 | 8 = 7,
//  weights?: BalanceWeights
// ) {
//  if (teamCount < 2) throw new Error("Number of teams must be at least 2.");
//  if (players.length < teamCount) throw new Error("Not enough players for that many teams.");
//  const W = mergedWeights(weights);
//  // Formation quotas
// // Dynamic formation quotas per team
// // FLEX = any extra players after quotas are filled
// const quota =
//  format === 6
//    ? { GK: 1, DEF: 2, MID: 2, FWD: 1 } // 6 total (balanced small-sided)
//    : format === 7
//      ? { GK: 1, DEF: 2, MID: 2, FWD: 1 } // 6 + FLEX
//      : { GK: 1, DEF: 2, MID: 3, FWD: 1 }; // 7 + FLEX

//  const teams: Team[] = Array.from({ length: teamCount }, (_, i) => ({
//    teamNumber: i + 1,
//    players: [],
//  }));
//  // Buckets
//  let gks = players.filter((p) => p.position === "GOALKEEPER");
//  let defs = players.filter((p) => p.position === "DEFENDER");
//  let mids = players.filter((p) => p.position === "MIDFIELDER");
//  let fwds = players.filter((p) => p.position === "FORWARD");
//  // 1) GK snake (1 per team if possible)
//  if (gks.length > 0) {
//    const remainingGKs = assignQuotaSnake(teams, gks, quota.GK, teamCount);
//    gks = remainingGKs;
//  }
//  // 2) DEF snake
//  if (defs.length > 0) {
//    const remainingDefs = assignQuotaSnake(teams, defs, quota.DEF, teamCount);
//    defs = remainingDefs;
//  }
//  // 3) MID snake
//  if (mids.length > 0) {
//    const remainingMids = assignQuotaSnake(teams, mids, quota.MID, teamCount);
//    mids = remainingMids;
//  }
//  // 4) FWD snake
//  if (fwds.length > 0) {
//    const remainingFwds = assignQuotaSnake(teams, fwds, quota.FWD, teamCount);
//    fwds = remainingFwds;
//  }
//  // 5) FLEX (remaining players by weakest-team-first using weighted impact)
//  const remaining = [...gks, ...defs, ...mids, ...fwds].sort((a, b) => playerImpact(b, W) - playerImpact(a, W));
//  for (const p of remaining) {
//    teams.sort((a, b) => teamStrength(a, W) - teamStrength(b, W));
//    teams[0].players.push(p);
//  }
//  // 6) Optimizer swaps to minimize fairness score
//  const iters = clamp(Number(W.optimizer.iterations ?? 0), 0, 5000);
//  const samePosBias = clamp(Number(W.optimizer.samePositionSwapBias ?? 0.7), 0, 1);
//  let bestScore = fairnessScore(teams, W);
//  function randomInt(n: number) {
//    return Math.floor(Math.random() * n);
//  }
//  for (let i = 0; i < iters; i++) {
//    const a = randomInt(teams.length);
//    let b = randomInt(teams.length);
//    if (b === a) b = (b + 1) % teams.length;
//    const ta = teams[a];
//    const tb = teams[b];
//    if (ta.players.length === 0 || tb.players.length === 0) continue;
//    // choose candidate players
//    let pa = ta.players[randomInt(ta.players.length)];
//    let pb = tb.players[randomInt(tb.players.length)];
//    // bias towards same-position swaps
//    if (Math.random() < samePosBias) {
//      const pos = pa.position;
//      const tbSame = tb.players.filter((p) => p.position === pos);
//      if (tbSame.length > 0) pb = tbSame[randomInt(tbSame.length)];
//    }
//    // perform swap
//    const ai = ta.players.findIndex((p) => p.id === pa.id);
//    const bi = tb.players.findIndex((p) => p.id === pb.id);
//    if (ai < 0 || bi < 0) continue;
//    ta.players[ai] = pb;
//    tb.players[bi] = pa;
//    const scoreNow = fairnessScore(teams, W);
//    if (scoreNow <= bestScore) {
//      bestScore = scoreNow; // keep
//    } else {
//      // revert
//      ta.players[ai] = pa;
//      tb.players[bi] = pb;
//    }
//  }
//  // return in teamNumber order
//  teams.sort((a, b) => a.teamNumber - b.teamNumber);
//  return teams;
// }

import type { Player, Rating, Position } from "@prisma/client";

const ratingWeight: Record<Rating, number> = {
  FAIR: 1,
  GOOD: 2,
  VERY_GOOD: 3,
  EXCELLENT: 4,
};

// If your Prisma Player now has stamina Int, it will exist.
// If not (older DB), we fallback to 3.
function getStamina(p: any): number {
  const n = Number(p?.stamina);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Team = {
  teamNumber: number;
  players: Player[];
  score: number;
  capacity: number;
};

function positionWeight(pos: Position): number {
  // small weights; GK handled separately by rule
  // You can tune these later if you want
  switch (pos) {
    case "DEFENDER":
      return 1;
    case "MIDFIELDER":
      return 2;
    case "FORWARD":
      return 2;
    case "GOALKEEPER":
      return 2;
    default:
      return 1;
  }
}

// Final “impact score” used for balancing
function impactScore(p: Player): number {
  const r = ratingWeight[p.rating];     // 1..4
  const s = getStamina(p);              // 1..5
  const pw = positionWeight(p.position);// 1..2
  // Multipliers (tweakable)
  return r * 10 + s * 2 + pw * 3;
}

function buildCapacities(playerCount: number, teamCount: number): number[] {
  const base = Math.floor(playerCount / teamCount);
  const rem = playerCount % teamCount;
  // first 'rem' teams get one extra player
  return Array.from({ length: teamCount }, (_, i) => base + (i < rem ? 1 : 0));
}

export function generateBalancedTeams(players: Player[], teamCount: number) {
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
    // sort strongest GK first, then distribute
    const gkSorted = shuffle(gks).sort((a, b) => impactScore(b) - impactScore(a));

    // assign up to one GK per team, but never exceed capacity
    for (let i = 0; i < Math.min(teamCount, gkSorted.length); i++) {
      // pick the team with lowest score that still has space
      const candidates = teams
        .filter((t) => t.players.length < t.capacity)
        .sort((a, b) => a.score - b.score);

      if (candidates.length === 0) break;

      const team = candidates[0];
      const gk = gkSorted[i];

      team.players.push(gk);
      team.score += impactScore(gk);
    }
  }

  const usedIds = new Set(teams.flatMap((t) => t.players.map((p) => p.id)));
  const remaining = [...others, ...gks.filter((gk) => !usedIds.has(gk.id))];

  // ---- Step 2: Distribute remaining strongest-first, respecting capacity ----
  const sorted = shuffle(remaining).sort((a, b) => impactScore(b) - impactScore(a));

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
    const team = best[Math.floor(Math.random() * best.length)];

    team.players.push(p);
    team.score += impactScore(p);
  }

  // Strip internal fields before returning
  return teams.map(({ score, capacity, ...t }) => t);
}
