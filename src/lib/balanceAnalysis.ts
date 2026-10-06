import {
  SKILL_WEIGHT,
  distributedRoles,
  effectiveRole,
  roleExcess,
  evaluateTeams,
  getStamina,
  impactScore,
  rosterRoleCoverage,
  type BalanceConfig,
  type BalanceMetrics,
  type EnginePlayer,
  type SkillRating,
} from "@/lib/balanceEngine";
import type { RoleRule, SportDefinition } from "@/lib/sports";

/**
 * M8-A — deterministic Balance Intelligence.
 *
 * Analyzes teams AFTER balance-v2 has generated them (the generator is not
 * changed): assignment quality (EVEN / CLOSE / UNEVEN from the team impact
 * spread), roster notes (limits caused by who was selected — e.g. one
 * setter for two teams), role coverage judged against what is ACHIEVABLE
 * with that roster, and the best role-safe single swap when it would make a
 * material difference. Deterministic and pure: no randomness, no database,
 * network or AI. Sport specifics come only from the SportDefinition's role
 * rules and labels — this file never names a sport or a role.
 *
 * Roster quality and assignment quality are deliberately separate: a role
 * shortage caused by the roster is a roster note, never an assignment
 * penalty.
 */

export const ANALYSIS_VERSION = "balance-analysis-v1" as const;
export const METRICS_VERSION = "metrics-v2" as const;

/** M8-v1 thresholds on the team impact spread (versioned with ANALYSIS_VERSION; not a Group setting). */
export const QUALITY_THRESHOLDS = { evenBelow: 4, unevenFrom: 10 } as const;
/** A swap is suggested only if it lowers the impact spread by at least this much AND improves the quality level. */
export const MIN_SWAP_IMPROVEMENT = 5;

export type BalanceQuality = "EVEN" | "CLOSE" | "UNEVEN";
const QUALITY_RANK: Record<BalanceQuality, number> = { UNEVEN: 0, CLOSE: 1, EVEN: 2 };

export function classifyQuality(impactSpread: number): BalanceQuality {
  if (impactSpread < QUALITY_THRESHOLDS.evenBelow) return "EVEN";
  if (impactSpread < QUALITY_THRESHOLDS.unevenFrom) return "CLOSE";
  return "UNEVEN";
}

/** The centralized M8-v1 materiality rule for swap suggestions. */
export function isMaterialImprovement(before: number, after: number): boolean {
  return before - after >= MIN_SWAP_IMPROVEMENT && QUALITY_RANK[classifyQuality(after)] > QUALITY_RANK[classifyQuality(before)];
}

export type RosterNote =
  | { level: "INFO" | "NOTICE"; code: "ROLE_SHORTAGE"; roleKey: string; available: number; needed: number; teamCount: number }
  | { level: "INFO"; code: "UNEVEN_TEAM_SIZES"; largerTeams: number[] }
  | { level: "INFO"; code: "UNKNOWN_ROLE"; roleKey: string; count: number; treatedAs: string };

export type RoleCoverage = {
  roleKey: string;
  mode: RoleRule["mode"];
  perTeam: number;
  available: number;
  /** Teams that have at least perTeam of the role. */
  covered: number;
  /** The most teams this roster can cover: min(teamCount, ⌊available ÷ perTeam⌋). */
  achievable: number;
  /** covered === achievable — the assignment did as well as the roster allows. */
  optimal: boolean;
};

export type SwapSuggestion = {
  teamA: number;
  playerA: string;
  roleA: string;
  teamB: number;
  playerB: string;
  roleB: string;
  sameRole: boolean;
  before: { quality: BalanceQuality; impactSpread: number };
  after: { quality: BalanceQuality; impactSpread: number; averageSkillSpread: number; staminaSpread: number };
};

export type BalanceAnalysis = {
  analysisVersion: typeof ANALYSIS_VERSION;
  quality: BalanceQuality;
  impactSpread: number;
  relativeImpactSpread: number;
  averageSkillSpread: number;
  staminaSpread: number;
  teamSizes: number[];
  rosterNotes: RosterNote[];
  roleCoverage: RoleCoverage[];
  improvable: boolean;
  /** Organizer-only, never persisted (contains player ids). */
  bestSwap: SwapSuggestion | null;
  swapCandidatesEvaluated: number;
  /** Deterministic, sport-labelled sentences (no LLM). */
  summary: string[];
};

/** What publish stores inside metricsJson (no player ids, no swap, no free text). */
export type StoredBalanceAnalysis = Omit<BalanceAnalysis, "bestSwap" | "swapCandidatesEvaluated" | "summary">;

export type StoredMetrics = BalanceMetrics & { metricsVersion: typeof METRICS_VERSION; analysis: StoredBalanceAnalysis };

type AnalysisTeam = { teamNumber: number; players: EnginePlayer[] };

const round = (n: number) => Math.round(n * 1000) / 1000;
const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
const countWord = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

function roleCoverageOf(sport: SportDefinition, config: BalanceConfig, teams: AnalysisTeam[]): RoleCoverage[] {
  const all = teams.flatMap((t) => t.players);
  return config.roleRules
    .filter((r) => r.mode !== "IGNORE")
    .map((r) => {
      const available = all.filter((p) => effectiveRole(sport, p.position) === r.roleKey).length;
      const covered = teams.filter((t) => t.players.filter((p) => effectiveRole(sport, p.position) === r.roleKey).length >= r.perTeam).length;
      const achievable = Math.min(teams.length, Math.floor(available / r.perTeam));
      return { roleKey: r.roleKey, mode: r.mode, perTeam: r.perTeam, available, covered, achievable, optimal: covered >= achievable };
    });
}

function rosterNotesOf(sport: SportDefinition, teams: AnalysisTeam[]): RosterNote[] {
  const all = teams.flatMap((t) => t.players);
  const notes: RosterNote[] = rosterRoleCoverage(sport, all, teams.length)
    .filter((c) => c.short)
    .map((c) => ({ level: c.warn ? "NOTICE" : "INFO", code: "ROLE_SHORTAGE", roleKey: c.roleKey, available: c.available, needed: c.needed, teamCount: teams.length }));
  const sizes = teams.map((t) => t.players.length);
  if (spread(sizes) > 0) {
    const max = Math.max(...sizes);
    notes.push({ level: "INFO", code: "UNEVEN_TEAM_SIZES", largerTeams: teams.filter((t) => t.players.length === max).map((t) => t.teamNumber) });
  }
  const unknown = new Map<string, number>();
  for (const p of all) if (!sport.roles.some((r) => r.key === p.position)) unknown.set(p.position, (unknown.get(p.position) ?? 0) + 1);
  for (const [roleKey, count] of [...unknown].sort(([a], [b]) => a.localeCompare(b))) {
    notes.push({ level: "INFO", code: "UNKNOWN_ROLE", roleKey, count, treatedAs: sport.defaultRoleKey });
  }
  return notes;
}

/**
 * Exhaustive, deterministic cross-team single-swap search. Team sizes are
 * fixed by construction. A swap is valid only if no role rule's covered-team
 * count drops and (M8.1) no distributable role becomes more concentrated
 * than before (the generator's position balancing is never undone). Ranking: impact spread, then average-skill spread, then
 * stamina spread, then same-role first, then stable team/player order.
 */
function findBestSwap(sport: SportDefinition, config: BalanceConfig, teams: AnalysisTeam[], current: { impactSpread: number; quality: BalanceQuality }) {
  const rules = config.roleRules.filter((r) => r.mode !== "IGNORE");
  const role = (p: EnginePlayer) => effectiveRole(sport, p.position);
  const impact = teams.map((t) => t.players.map((p) => impactScore(sport, config, p)));
  const skill = teams.map((t) => t.players.map((p) => SKILL_WEIGHT[p.rating as SkillRating] ?? 2));
  const stamina = teams.map((t) => t.players.map((p) => getStamina(p)));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const impactTotals = impact.map(sum);
  const skillTotals = skill.map(sum);
  const staminaTotals = stamina.map(sum);
  const sizes = teams.map((t) => t.players.length);
  const roleCounts = teams.map((t) => {
    const m = new Map<string, number>();
    for (const p of t.players) m.set(role(p), (m.get(role(p)) ?? 0) + 1);
    return m;
  });
  const coveredBefore = rules.map((r) => roleCounts.filter((m) => (m.get(r.roleKey) ?? 0) >= r.perTeam).length);
  const distributed = new Set(distributedRoles(sport, config));
  const excessAfterSwap = (roleKey: string, a: number, b: number, ra: string, rb: string) =>
    roleExcess(roleCounts.map((m, t) => (m.get(roleKey) ?? 0) + (t === a ? Number(rb === roleKey) - Number(ra === roleKey) : t === b ? Number(ra === roleKey) - Number(rb === roleKey) : 0)));
  const excessBefore = (roleKey: string) => roleExcess(roleCounts.map((m) => m.get(roleKey) ?? 0));

  type Candidate = { a: number; i: number; b: number; j: number; impactSpread: number; averageSkillSpread: number; staminaSpread: number; sameRole: boolean };
  let best: Candidate | null = null;
  let evaluated = 0;
  const better = (x: Candidate, y: Candidate) =>
    x.impactSpread !== y.impactSpread ? x.impactSpread < y.impactSpread
    : x.averageSkillSpread !== y.averageSkillSpread ? x.averageSkillSpread < y.averageSkillSpread
    : x.staminaSpread !== y.staminaSpread ? x.staminaSpread < y.staminaSpread
    : x.sameRole !== y.sameRole ? x.sameRole
    : false; // equal on every criterion: keep the first in stable (a, i, b, j) order

  for (let a = 0; a < teams.length; a++) {
    for (let b = a + 1; b < teams.length; b++) {
      for (let i = 0; i < teams[a].players.length; i++) {
        for (let j = 0; j < teams[b].players.length; j++) {
          evaluated++;
          const pa = teams[a].players[i];
          const pb = teams[b].players[j];
          const ra = role(pa);
          const rb = role(pb);
          // Role safety: no rule may lose a covered team.
          if (ra !== rb) {
            const unsafe = rules.some((r, k) => {
              if (r.roleKey !== ra && r.roleKey !== rb) return false;
              const has = (team: number) => (roleCounts[team].get(r.roleKey) ?? 0) >= r.perTeam;
              const after = (team: number, out: string, inn: string) =>
                (roleCounts[team].get(r.roleKey) ?? 0) - (out === r.roleKey ? 1 : 0) + (inn === r.roleKey ? 1 : 0) >= r.perTeam;
              const covered = coveredBefore[k] - Number(has(a)) - Number(has(b)) + Number(after(a, ra, rb)) + Number(after(b, rb, ra));
              return covered < coveredBefore[k];
            });
            if (unsafe) continue;
            // M8.1 — never re-concentrate a role the generator spread out.
            const sum2 = (x: string, y: string, f: (k: string) => number) => (distributed.has(x) ? f(x) : 0) + (distributed.has(y) ? f(y) : 0);
            if (sum2(ra, rb, (k) => excessAfterSwap(k, a, b, ra, rb)) > sum2(ra, rb, excessBefore)) continue;
          }
          const totals = [...impactTotals];
          totals[a] += impact[b][j] - impact[a][i];
          totals[b] += impact[a][i] - impact[b][j];
          const skills = [...skillTotals];
          skills[a] += skill[b][j] - skill[a][i];
          skills[b] += skill[a][i] - skill[b][j];
          const stams = [...staminaTotals];
          stams[a] += stamina[b][j] - stamina[a][i];
          stams[b] += stamina[a][i] - stamina[b][j];
          const cand: Candidate = {
            a, i, b, j,
            impactSpread: round(spread(totals)),
            averageSkillSpread: round(spread(skills.map((s, t) => (sizes[t] ? s / sizes[t] : 0)))),
            staminaSpread: round(spread(stams.map((s, t) => (sizes[t] ? s / sizes[t] : 0)))),
            sameRole: ra === rb,
          };
          if (!best || better(cand, best)) best = cand;
        }
      }
    }
  }

  let suggestion: SwapSuggestion | null = null;
  const chosen = best as Candidate | null;
  if (chosen && isMaterialImprovement(current.impactSpread, chosen.impactSpread)) {
    const pa = teams[chosen.a].players[chosen.i];
    const pb = teams[chosen.b].players[chosen.j];
    suggestion = {
      teamA: teams[chosen.a].teamNumber,
      playerA: pa.id,
      roleA: role(pa),
      teamB: teams[chosen.b].teamNumber,
      playerB: pb.id,
      roleB: role(pb),
      sameRole: chosen.sameRole,
      before: current,
      after: { quality: classifyQuality(chosen.impactSpread), impactSpread: chosen.impactSpread, averageSkillSpread: chosen.averageSkillSpread, staminaSpread: chosen.staminaSpread },
    };
  }
  return { suggestion, evaluated };
}

function summaryOf(sport: SportDefinition, a: Omit<BalanceAnalysis, "summary">): string[] {
  const label = (key: string) => sport.roles.find((r) => r.key === key);
  const lines = [
    a.quality === "EVEN" ? "Teams are evenly matched." : a.quality === "CLOSE" ? "Teams are closely matched." : "The teams have a noticeable strength difference.",
  ];
  for (const c of a.roleCoverage) {
    const r = label(c.roleKey);
    if (!r) continue;
    const short = a.rosterNotes.find((n) => n.code === "ROLE_SHORTAGE" && n.roleKey === c.roleKey);
    if (c.covered === a.teamSizes.length && c.perTeam === 1) lines.push(`Each team has a ${r.label}.`);
    else if (short && short.code === "ROLE_SHORTAGE") lines.push(`${countWord(short.available, r.label, r.pluralLabel)} available for ${short.teamCount} teams.`);
  }
  const sizes = a.rosterNotes.find((n) => n.code === "UNEVEN_TEAM_SIZES");
  if (sizes && sizes.code === "UNEVEN_TEAM_SIZES") {
    const t = sizes.largerTeams;
    lines.push(t.length === 1 ? `Team ${t[0]} has one extra player.` : `Teams ${t.join(", ")} each have one extra player.`);
  }
  lines.push(a.improvable ? "A single swap can make the teams more even." : a.quality === "EVEN" ? "No change needed." : "No single swap would noticeably improve these teams.");
  return lines;
}

/** Deterministic analysis of already-generated teams (identical input → identical output). */
export function analyzeTeams(sport: SportDefinition, config: BalanceConfig, teams: AnalysisTeam[]): BalanceAnalysis {
  const metrics = evaluateTeams(sport, config, teams);
  const impactSpread = metrics.impactSpread;
  const quality = classifyQuality(impactSpread);
  const roleCoverage = roleCoverageOf(sport, config, teams);
  const rosterNotes = rosterNotesOf(sport, teams);
  const { suggestion, evaluated } = findBestSwap(sport, config, teams, { impactSpread, quality });
  const base = {
    analysisVersion: ANALYSIS_VERSION,
    quality,
    impactSpread,
    relativeImpactSpread: metrics.relativeImpactSpread,
    averageSkillSpread: metrics.averageSkillSpread,
    staminaSpread: metrics.averageStaminaSpread,
    teamSizes: metrics.teams.map((t) => t.size),
    rosterNotes,
    roleCoverage,
    improvable: suggestion !== null,
    bestSwap: suggestion,
    swapCandidatesEvaluated: evaluated,
  };
  return { ...base, summary: summaryOf(sport, base) };
}

/** The persistable part of an analysis: no player ids, no swap, no text. */
export function toStoredAnalysis(a: BalanceAnalysis): StoredBalanceAnalysis {
  const { bestSwap: _bestSwap, swapCandidatesEvaluated: _evaluated, summary: _summary, ...stored } = a;
  void _bestSwap;
  void _evaluated;
  void _summary;
  return stored;
}

/** metricsJson content written by publish from M8 on (metrics-v2). */
export function buildStoredMetrics(sport: SportDefinition, config: BalanceConfig, teams: AnalysisTeam[]): StoredMetrics {
  return { metricsVersion: METRICS_VERSION, ...evaluateTeams(sport, config, teams), analysis: toStoredAnalysis(analyzeTeams(sport, config, teams)) };
}

/**
 * Tolerant reader for TeamGeneration.metricsJson across versions:
 * null (pre-M7) → "none"; M7 rows (no metricsVersion) → "metrics-v1";
 * M8 rows → "metrics-v2" with an analysis block. Never throws.
 */
export function parseStoredMetrics(metricsJson: string | null | undefined):
  | { version: "none" }
  | { version: "metrics-v1"; metrics: BalanceMetrics }
  | { version: "metrics-v2"; metrics: StoredMetrics }
  | { version: "unreadable" } {
  if (!metricsJson) return { version: "none" };
  try {
    const parsed = JSON.parse(metricsJson);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.teams)) return { version: "unreadable" };
    if (parsed.metricsVersion === METRICS_VERSION) return { version: "metrics-v2", metrics: parsed as StoredMetrics };
    return { version: "metrics-v1", metrics: parsed as BalanceMetrics };
  } catch {
    return { version: "unreadable" };
  }
}

/**
 * Swap two players between different teams, keeping every other position
 * (and therefore team sizes) unchanged. Returns null if either player is
 * missing or both are on the same team.
 */
export function applySwap<P extends { id: string }>(
  teams: Array<{ teamNumber: number; players: P[] }>,
  playerA: string,
  playerB: string
): Array<{ teamNumber: number; players: P[] }> | null {
  const locate = (id: string) => {
    for (let t = 0; t < teams.length; t++) {
      const i = teams[t].players.findIndex((p) => p.id === id);
      if (i >= 0) return { t, i };
    }
    return null;
  };
  const a = locate(playerA);
  const b = locate(playerB);
  if (!a || !b || a.t === b.t) return null;
  const next = teams.map((t) => ({ ...t, players: [...t.players] }));
  next[a.t].players[a.i] = teams[b.t].players[b.i];
  next[b.t].players[b.i] = teams[a.t].players[a.i];
  return next;
}
