import type { RoleRule, SportDefinition } from "@/lib/sports";

/**
 * M7 — the sport-neutral, deterministic team-balancing engine.
 *
 * Pure: no database, network, Telegram, WhatsApp or AI calls. Given the
 * selected players, a team count, the Group's SportDefinition and its
 * bounded GroupSetting overrides, it returns teams + metrics + structured
 * warnings. Sport specifics (goalkeepers, setters, quarterbacks…) live
 * only in the sport definitions' roleRules — this file never names a role.
 *
 * Soccer compatibility contract (M8.1): steps 1–2 are still exactly the
 * pre-M7 generateBalancedTeams() (same impact formula, shuffle/sort/
 * tie-break order and rng call sequence). Step 3 (M8.1) then only moves
 * players when that spreads a role more evenly within the impact-spread
 * budget — so the result equals the pre-M7 split whenever that split is
 * already as even as the roster allows, and otherwise is strictly better
 * distributed (src/lib/__tests__/balanceEngine.parity.test.ts).
 */

export const ENGINE_VERSION = "balance-v3";

export type SkillRating = "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";

/** Skill → numeric strength (unchanged from the pre-M7 RATING_WEIGHT). */
export const SKILL_WEIGHT: Record<SkillRating, number> = { FAIR: 1, GOOD: 2, VERY_GOOD: 3, EXCELLENT: 4 };

const MIN_STAMINA = 1;
const MAX_STAMINA = 5;
const DEFAULT_STAMINA = 3;

/** What the engine reads from a player. Extra fields are carried through untouched. */
export type EnginePlayer = {
  id: string;
  rating: string;
  /** Sport-scoped role key (stored in Player.position). */
  position: string;
  stamina?: number | null;
};

/** The parts of a SportDefinition the role helpers need (also available client-side). */
export type SportRules = Pick<SportDefinition, "roles" | "defaultRoleKey" | "roleRules">;

export type BalanceConfig = {
  staminaCoef: number;
  roleWeights: Record<string, number>;
  roleRules: RoleRule[];
};

export function getStamina(p: { stamina?: number | null }): number {
  const n = Number(p?.stamina);
  return Number.isFinite(n) ? Math.min(MAX_STAMINA, Math.max(MIN_STAMINA, n)) : DEFAULT_STAMINA;
}

/**
 * The sport's defaults merged with the Group's stored `balanceWeights`
 * GroupSetting ({ staminaCoef?, positionWeights? }). Never throws:
 * malformed values fall back field by field (same rules as the pre-M7
 * mergeBalanceWeights), and only the sport's own role keys are read.
 */
export function resolveBalanceConfig(sport: SportDefinition, stored?: unknown): BalanceConfig {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const staminaCoefRaw = Number(raw.staminaCoef);
  const staminaCoef = Number.isFinite(staminaCoefRaw) ? staminaCoefRaw : sport.defaults.staminaCoef;
  const rawWeights = (raw.positionWeights && typeof raw.positionWeights === "object" ? raw.positionWeights : {}) as Record<string, unknown>;
  const roleWeights: Record<string, number> = {};
  for (const role of sport.roles) {
    const v = Number(rawWeights[role.key]);
    roleWeights[role.key] = Number.isFinite(v) ? v : role.defaultWeight;
  }
  return { staminaCoef, roleWeights, roleRules: sport.roleRules };
}

/** Role key used for balancing: unknown/legacy keys count as the sport's default role. */
export function effectiveRole(sport: Pick<SportDefinition, "roles" | "defaultRoleKey">, roleKey: string): string {
  return sport.roles.some((r) => r.key === roleKey) ? roleKey : sport.defaultRoleKey;
}

/**
 * A player's balancing "impact score" — skill dominates; stamina and
 * role weight are smaller modifiers. Same expression (and float
 * evaluation order) as the pre-M7 getPlayerImpactScore.
 */
export function impactScore(sport: SportDefinition, config: BalanceConfig, player: EnginePlayer): number {
  const rating = SKILL_WEIGHT[player.rating as SkillRating] ?? 2;
  const stamina = getStamina(player);
  const positionWeight = config.roleWeights[effectiveRole(sport, player.position)] ?? 1;
  return rating * 10 + stamina * 2 * config.staminaCoef + positionWeight * 3;
}

// ------------------------------------------------------------------ warnings

export type EngineWarning =
  | {
      code: "ROLE_SHORTAGE";
      roleKey: string;
      mode: RoleRule["mode"];
      available: number;
      needed: number;
      perTeam: number;
      teamCount: number;
      teamsCovered: number | null;
    }
  | { code: "UNKNOWN_ROLE"; roleKey: string; count: number; treatedAs: string };

export type RoleCoverage = {
  roleKey: string;
  mode: RoleRule["mode"];
  perTeam: number;
  available: number;
  needed: number;
  short: boolean;
  /** Whether the sport asks to warn about a shortage (else informational). */
  warn: boolean;
};

/** Pre-generation roster check (also used by the Generate UI). IGNORE rules are skipped. */
export function rosterRoleCoverage(sport: SportRules, players: Array<Pick<EnginePlayer, "position">>, teamCount: number): RoleCoverage[] {
  return sport.roleRules
    .filter((rule) => rule.mode !== "IGNORE")
    .map((rule) => {
      const available = players.filter((p) => effectiveRole(sport, p.position) === rule.roleKey).length;
      const needed = rule.perTeam * teamCount;
      return { roleKey: rule.roleKey, mode: rule.mode, perTeam: rule.perTeam, available, needed, short: available < needed, warn: rule.warnWhenShort };
    });
}

function unknownRoleWarnings(sport: SportDefinition, players: EnginePlayer[]): EngineWarning[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    if (!sport.roles.some((r) => r.key === p.position)) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([roleKey, count]) => ({ code: "UNKNOWN_ROLE", roleKey, count, treatedAs: sport.defaultRoleKey }));
}

// ------------------------------------------------------------------ metrics

export type TeamMetrics = {
  teamNumber: number;
  size: number;
  impactTotal: number;
  averageSkill: number;
  skillCounts: Record<SkillRating, number>;
  averageStamina: number;
  roleCounts: Record<string, number>;
  /** How many of the overall top-`teamCount` players (by impact) are on this team. */
  topPlayers: number;
};

/**
 * Deterministic balance metrics. Aggregates only — never player ids,
 * names or any identity data (safe for public/AI-ready use).
 */
export type BalanceMetrics = {
  teamCount: number;
  playerCount: number;
  teams: TeamMetrics[];
  sizeSpread: number;
  impactSpread: number;
  /** impactSpread ÷ mean team impact (0 when the mean is 0). */
  relativeImpactSpread: number;
  averageSkillSpread: number;
  averageStaminaSpread: number;
  ruleCoverage: Array<{ roleKey: string; mode: RoleRule["mode"]; perTeam: number; available: number; teamsCovered: number; teamCount: number }>;
  /**
   * M8.1 — how each distributable role is spread across teams (team order).
   * `excess` = players above/below the most even split possible for that
   * role (0 = as even as the roster allows). Optional: absent on metrics
   * stored before M8.1.
   */
  roleDistribution?: Array<{ roleKey: string; available: number; perTeam: number[]; excess: number }>;
};

const round = (n: number, places = 3) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

export function evaluateTeams(
  sport: SportDefinition,
  config: BalanceConfig,
  teams: Array<{ teamNumber: number; players: EnginePlayer[] }>
): BalanceMetrics {
  const all = teams.flatMap((t) => t.players);
  const ranked = [...all].sort((a, b) => impactScore(sport, config, b) - impactScore(sport, config, a));
  const top = new Set(ranked.slice(0, teams.length));

  const teamMetrics: TeamMetrics[] = teams.map((t) => {
    const n = t.players.length;
    const skillCounts: Record<SkillRating, number> = { FAIR: 0, GOOD: 0, VERY_GOOD: 0, EXCELLENT: 0 };
    const roleCounts: Record<string, number> = {};
    let impact = 0;
    let skill = 0;
    let stamina = 0;
    for (const p of t.players) {
      impact += impactScore(sport, config, p);
      skill += SKILL_WEIGHT[p.rating as SkillRating] ?? 2;
      stamina += getStamina(p);
      if (p.rating in skillCounts) skillCounts[p.rating as SkillRating]++;
      const role = effectiveRole(sport, p.position);
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    }
    return {
      teamNumber: t.teamNumber,
      size: n,
      impactTotal: round(impact),
      averageSkill: n ? round(skill / n) : 0,
      skillCounts,
      averageStamina: n ? round(stamina / n) : 0,
      roleCounts,
      topPlayers: t.players.filter((p) => top.has(p)).length,
    };
  });

  const impacts = teamMetrics.map((t) => t.impactTotal);
  const meanImpact = impacts.length ? impacts.reduce((a, b) => a + b, 0) / impacts.length : 0;
  const impactSpread = round(spread(impacts));

  return {
    teamCount: teams.length,
    playerCount: all.length,
    teams: teamMetrics,
    sizeSpread: spread(teamMetrics.map((t) => t.size)),
    impactSpread,
    relativeImpactSpread: meanImpact > 0 ? round(impactSpread / meanImpact, 4) : 0,
    averageSkillSpread: round(spread(teamMetrics.map((t) => t.averageSkill))),
    averageStaminaSpread: round(spread(teamMetrics.map((t) => t.averageStamina))),
    ruleCoverage: config.roleRules
      .filter((r) => r.mode !== "IGNORE")
      .map((r) => ({
        roleKey: r.roleKey,
        mode: r.mode,
        perTeam: r.perTeam,
        available: all.filter((p) => effectiveRole(sport, p.position) === r.roleKey).length,
        teamsCovered: teamMetrics.filter((t) => (t.roleCounts[r.roleKey] ?? 0) >= r.perTeam).length,
        teamCount: teams.length,
      })),
    roleDistribution: distributedRoles(sport, config)
      .map((roleKey) => {
        const perTeam = teamMetrics.map((t) => t.roleCounts[roleKey] ?? 0);
        const available = perTeam.reduce((a, b) => a + b, 0);
        return { roleKey, available, perTeam, excess: roleExcess(perTeam) };
      })
      .filter((d) => d.available > 0),
  };
}

// ------------------------------------------------------------------ role distribution (M8.1)

/**
 * Roles whose players should be spread evenly across teams: every sport role
 * except the generic default ("Any" / "All-around" / "Athlete" / "Player" —
 * flexible by definition) and roles whose rule says IGNORE. Read from the
 * SportDefinition only — no role is named here.
 */
export function distributedRoles(sport: Pick<SportDefinition, "roles" | "defaultRoleKey">, config: Pick<BalanceConfig, "roleRules">): string[] {
  const ignored = new Set(config.roleRules.filter((r) => r.mode === "IGNORE").map((r) => r.roleKey));
  return sport.roles.map((r) => r.key).filter((k) => k !== sport.defaultRoleKey && !ignored.has(k));
}

/**
 * How far one role's per-team counts are from the most even split possible:
 * with c players over T teams every team should hold ⌊c/T⌋ or ⌈c/T⌉; each
 * player above ⌈c/T⌉ or missing below ⌊c/T⌋ counts 1. 4 defenders / 3 teams:
 * 2/1/1 → 0, 2/2/0 or 2/0/2 → 1, 3/1/0 → 2. 2 over 3: 1/1/0 → 0, 2/0/0 → 1.
 */
export function roleExcess(perTeam: number[]): number {
  const total = perTeam.reduce((a, b) => a + b, 0);
  if (total === 0 || perTeam.length === 0) return 0;
  const lo = Math.floor(total / perTeam.length);
  const hi = Math.ceil(total / perTeam.length);
  return perTeam.reduce((n, c) => n + Math.max(0, c - hi) + Math.max(0, lo - c), 0);
}

/** Total excess over every distributable role (0 = every role spread as evenly as possible). */
export function roleDistributionPenalty(
  sport: Pick<SportDefinition, "roles" | "defaultRoleKey">,
  config: Pick<BalanceConfig, "roleRules">,
  teams: Array<{ players: Array<Pick<EnginePlayer, "position">> }>
): number {
  return distributedRoles(sport, config).reduce(
    (n, roleKey) => n + roleExcess(teams.map((t) => t.players.filter((p) => effectiveRole(sport, p.position) === roleKey).length)),
    0
  );
}

/**
 * Impact-spread budget for position improvements: never above the greedy
 * split's own spread or 5% of the mean team impact, whichever is larger
 * (about one skill step on one player for 6-a-side teams). A better
 * position spread never buys an obviously unbalanced split.
 */
export const POSITION_SPREAD_TOLERANCE = 0.05;

// ------------------------------------------------------------------ generation

export type GenerateTeamsInput<P extends EnginePlayer> = {
  players: P[];
  teamCount: number;
  sport: SportDefinition;
  config: BalanceConfig;
  rng?: () => number;
  /**
   * M8.1 — diagnostic only: false skips step 3 (the pre-M8.1 greedy split,
   * for comparisons/tests). Production generation never passes it.
   */
  balanceRoles?: boolean;
};

export type GenerateTeamsResult<P extends EnginePlayer> = {
  teams: Array<{ teamNumber: number; players: P[] }>;
  metrics: BalanceMetrics;
  warnings: EngineWarning[];
  engineVersion: string;
  sportKey: string;
  sportVersion: number;
};

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * M8.1 — step 3, deterministic position balancing on top of the greedy split.
 *
 * Quality is compared lexicographically:
 *   (1) rule-role coverage shortfall (teams still short of a SEED/SPREAD role
 *       the roster could cover),
 *   (2) the role-distribution penalty (roleExcess over every distributable role),
 *   (3) impact spread.
 * Moves are single cross-team swaps (team sizes never change), applied
 * best-first: lowest (1, 2), then lowest spread, then first in stable
 * (team, player) order. No rng — the same greedy split always gives the same
 * result, and a split that is already as even as the roster allows is never
 * touched.
 *
 * Skill guard: the final impact spread never exceeds
 *   max(greedy spread, POSITION_SPREAD_TOLERANCE × mean team impact).
 * To find position fixes that need a little re-balancing, a first attempt
 * allows position swaps up to twice that budget and then applies skill-repair
 * swaps (never worsening (1) or (2)); if it still ends above the budget, the
 * strict attempt (position swaps within the budget only) is used instead.
 */
function improveRoleDistribution<P extends EnginePlayer>(
  sport: SportDefinition,
  config: BalanceConfig,
  teams: Array<{ players: P[]; score: number }>,
  score: (p: P) => number,
  roleOf: (p: P) => string
) {
  const rules = config.roleRules.filter((r) => r.mode !== "IGNORE");
  const roles = distributedRoles(sport, config);
  if (roles.length === 0 && rules.length === 0) return;

  type State = { players: P[][]; scores: number[] };
  const quality = (st: State) => {
    const counts = (roleKey: string) => st.players.map((ps) => ps.filter((p) => roleOf(p) === roleKey).length);
    const shortfall = rules.reduce((n, r) => {
      const c = counts(r.roleKey);
      const achievable = Math.min(st.players.length, Math.floor(c.reduce((a, b) => a + b, 0) / r.perTeam));
      return n + Math.max(0, achievable - c.filter((x) => x >= r.perTeam).length);
    }, 0);
    const penalty = roles.reduce((n, k) => n + roleExcess(counts(k)), 0);
    return { shortfall, penalty, spread: spread(st.scores) };
  };
  type Q = ReturnType<typeof quality>;
  const positionBetter = (a: Q, b: Q) => a.shortfall < b.shortfall || (a.shortfall === b.shortfall && a.penalty < b.penalty);
  const positionNotWorse = (a: Q, b: Q) => a.shortfall < b.shortfall || (a.shortfall === b.shortfall && a.penalty <= b.penalty);

  const start: State = { players: teams.map((t) => [...t.players]), scores: teams.map((t) => t.score) };
  const q0 = quality(start);
  if (q0.shortfall === 0 && q0.penalty === 0) return;
  const mean = start.scores.reduce((a, b) => a + b, 0) / start.scores.length;
  const budget = Math.max(q0.spread, POSITION_SPREAD_TOLERANCE * mean) + 1e-9;
  const maxSteps = 4 * teams.reduce((n, t) => n + t.players.length, 0);

  /** Best single swap by `accept` + ranking; null when none. */
  const bestSwap = (st: State, cur: Q, accept: (c: Q, cur: Q) => boolean) => {
    let best: { a: number; i: number; b: number; j: number; q: Q } | null = null;
    for (let a = 0; a < st.players.length; a++) {
      for (let b = a + 1; b < st.players.length; b++) {
        for (let i = 0; i < st.players[a].length; i++) {
          for (let j = 0; j < st.players[b].length; j++) {
            const pa = st.players[a][i];
            const pb = st.players[b][j];
            if (roleOf(pa) === roleOf(pb) && score(pa) === score(pb)) continue; // changes nothing
            st.players[a][i] = pb;
            st.players[b][j] = pa;
            const d = score(pb) - score(pa);
            st.scores[a] += d;
            st.scores[b] -= d;
            const q = quality(st);
            st.scores[a] -= d;
            st.scores[b] += d;
            st.players[a][i] = pa;
            st.players[b][j] = pb;
            if (!accept(q, cur)) continue;
            if (!best || positionBetter(q, best.q) || (!positionBetter(best.q, q) && q.spread < best.q.spread)) best = { a, i, b, j, q };
          }
        }
      }
    }
    return best;
  };
  const apply = (st: State, m: { a: number; i: number; b: number; j: number }) => {
    const pa = st.players[m.a][m.i];
    const pb = st.players[m.b][m.j];
    st.players[m.a][m.i] = pb;
    st.players[m.b][m.j] = pa;
    st.scores[m.a] += score(pb) - score(pa);
    st.scores[m.b] += score(pa) - score(pb);
  };
  const clone = (st: State): State => ({ players: st.players.map((ps) => [...ps]), scores: [...st.scores] });

  const attempt = (positionBudget: number, repair: boolean): State => {
    const st = clone(start);
    let cur = q0;
    for (let n = 0; n < maxSteps; n++) {
      const m = bestSwap(st, cur, (c, k) => positionBetter(c, k) && c.spread <= positionBudget);
      if (!m) break;
      apply(st, m);
      cur = m.q;
    }
    if (repair) {
      for (let n = 0; n < maxSteps && cur.spread > budget; n++) {
        const m = bestSwap(st, cur, (c, k) => positionNotWorse(c, k) && c.spread < k.spread - 1e-9);
        if (!m) break;
        apply(st, m);
        cur = m.q;
      }
    }
    return st;
  };

  let chosen = attempt(2 * budget, true);
  if (quality(chosen).spread > budget) chosen = attempt(budget, false);
  if (!positionBetter(quality(chosen), q0)) return;
  teams.forEach((t, k) => {
    t.players = chosen.players[k];
    t.score = chosen.scores[k];
  });
}

function buildCapacities(playerCount: number, teamCount: number): number[] {
  const base = Math.floor(playerCount / teamCount);
  const rem = playerCount % teamCount;
  return Array.from({ length: teamCount }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * Greedy, weakest-team-first balancing:
 *  1) each SEED rule (definition order): its role players, strongest first,
 *     up to perTeam×teamCount, each onto the currently weakest team with room;
 *  2) everyone else (plus SEED overflow), strongest first, onto the weakest
 *     team with room — a SPREAD role prefers teams still short of it, and
 *     others keep a short team's last slots free while SPREAD players
 *     remain (soft: ignored if no other team has room); score ties are
 *     broken with rng. With no SPREAD rules (soccer) step 2 is exactly
 *     the pre-M7 loop.
 * Live generation passes Math.random (re-running Generate may give a
 * different valid split, by design); tests pass a seeded rng.
 *
 * 3) M8.1 — improveRoleDistribution(): deterministic swaps that spread every
 *    distributable role (and rule roles' coverage) as evenly as the roster
 *    allows, within a bounded impact-spread budget.
 *
 * Hard constraints only: ≥2 teams, ≥teamCount players, sizes within ±1,
 * no duplicated or dropped players. Role shortages are warnings.
 */
export function generateTeams<P extends EnginePlayer>(input: GenerateTeamsInput<P>): GenerateTeamsResult<P> {
  const { players, teamCount, sport, config } = input;
  const rng = input.rng ?? Math.random;
  if (teamCount < 2) throw new Error("Number of teams must be at least 2.");
  if (players.length < teamCount) throw new Error("Not enough players for that many teams.");
  if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error("A player was selected more than once.");

  const score = (p: P) => impactScore(sport, config, p);
  const roleOf = (p: P) => effectiveRole(sport, p.position);
  const capacities = buildCapacities(players.length, teamCount);
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    teamNumber: i + 1,
    players: [] as P[],
    score: 0,
    capacity: capacities[i],
  }));
  const withRoom = () => teams.filter((t) => t.players.length < t.capacity).sort((a, b) => a.score - b.score);

  // ---- Step 1: SEED rules ----
  const seedRules = config.roleRules.filter((r) => r.mode === "SEED");
  const seedRoleKeys = new Set(seedRules.map((r) => r.roleKey));
  const seeded = new Set<string>();
  for (const rule of seedRules) {
    const rolePlayers = players.filter((p) => roleOf(p) === rule.roleKey);
    if (rolePlayers.length === 0) continue;
    const sorted = shuffle(rolePlayers, rng).sort((a, b) => score(b) - score(a));
    for (let i = 0; i < Math.min(rule.perTeam * teamCount, sorted.length); i++) {
      const candidates = withRoom();
      if (candidates.length === 0) break;
      const team = candidates[0];
      team.players.push(sorted[i]);
      team.score += score(sorted[i]);
      seeded.add(sorted[i].id);
    }
  }

  // ---- Step 2: everyone else, strongest first ----
  const remaining = [
    ...players.filter((p) => !seedRoleKeys.has(roleOf(p))),
    ...seedRules.flatMap((rule) => players.filter((p) => roleOf(p) === rule.roleKey && !seeded.has(p.id))),
  ];
  const spreadRules = new Map(config.roleRules.filter((r) => r.mode === "SPREAD").map((r) => [r.roleKey, r]));
  const sorted = shuffle(remaining, rng).sort((a, b) => score(b) - score(a));

  // SPREAD bookkeeping: role players not yet placed, per SPREAD rule.
  const unplaced = new Map([...spreadRules.keys()].map((k) => [k, sorted.filter((p) => roleOf(p) === k).length]));
  const countRole = (t: (typeof teams)[number], roleKey: string) => t.players.filter((x) => roleOf(x) === roleKey).length;
  // Slots a team keeps free for SPREAD roles it still lacks while such players remain.
  const reservedSlots = (t: (typeof teams)[number]) => {
    let n = 0;
    for (const [roleKey, rule] of spreadRules) {
      const pending = unplaced.get(roleKey) ?? 0;
      if (pending > 0) n += Math.min(pending, Math.max(0, rule.perTeam - countRole(t, roleKey)));
    }
    return n;
  };

  for (const p of sorted) {
    let candidates = withRoom();
    if (candidates.length === 0) break; // cannot happen with correct capacities

    const role = roleOf(p);
    const spreadRule = spreadRules.get(role);
    if (spreadRule) unplaced.set(role, (unplaced.get(role) ?? 1) - 1);
    const lacking = spreadRule ? candidates.filter((t) => countRole(t, spreadRule.roleKey) < spreadRule.perTeam) : [];
    if (lacking.length > 0) {
      // A SPREAD role player prefers a team still short of its role.
      candidates = lacking;
    } else if (spreadRules.size > 0) {
      // Everyone else avoids a team's last free slots reserved for a SPREAD
      // role it still lacks — unless that would leave nowhere to go (soft).
      const free = candidates.filter((t) => t.capacity - t.players.length > reservedSlots(t));
      if (free.length > 0) candidates = free;
    }

    const minScore = candidates[0].score;
    const best = candidates.filter((t) => t.score === minScore);
    const team = best[Math.floor(rng() * best.length)];
    team.players.push(p);
    team.score += score(p);
  }

  if (input.balanceRoles !== false) improveRoleDistribution(sport, config, teams, score, roleOf);

  const result = teams.map(({ teamNumber, players: ps }) => ({ teamNumber, players: ps }));
  const placed = result.reduce((n, t) => n + t.players.length, 0);
  if (placed !== players.length) throw new Error("Team generation failed to place every player.");

  const metrics = evaluateTeams(sport, config, result);
  const warnings: EngineWarning[] = [
    ...rosterRoleCoverage(sport, players, teamCount)
      .filter((c) => c.short && c.warn)
      .map((c): EngineWarning => ({
        code: "ROLE_SHORTAGE",
        roleKey: c.roleKey,
        mode: c.mode,
        available: c.available,
        needed: c.needed,
        perTeam: c.perTeam,
        teamCount,
        teamsCovered: metrics.ruleCoverage.find((r) => r.roleKey === c.roleKey)?.teamsCovered ?? null,
      })),
    ...unknownRoleWarnings(sport, players),
  ];

  return { teams: result, metrics, warnings, engineVersion: ENGINE_VERSION, sportKey: sport.key, sportVersion: sport.version };
}
