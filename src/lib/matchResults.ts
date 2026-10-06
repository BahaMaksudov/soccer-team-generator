/**
 * M8.1 — the Match result model: pairwise FIXTURES.
 *
 * A Match with N published teams is a round of separate games between pairs
 * of teams: every unordered pair plays exactly once, N × (N − 1) / 2 fixtures,
 * each with two independent scores. A 3-team match is never one simultaneous
 * contest, so there is no "5 – 3 – 2" result and no invented overall winner.
 *
 * Storage (no schema change): MatchResult.scoresJson stays a JSON string.
 *  - 2 teams: written EXACTLY as before — `[{teamNumber,score},{teamNumber,score}]`
 *    — so historical and new two-team rows are byte-compatible.
 *  - 3+ teams: `{"format":"fixtures-v1","fixtures":[{teamA,teamB,scoreA,scoreB}…]}`.
 * Reading accepts both. A historical array with 3+ entries (one score per team,
 * saved before M8.1) cannot be turned into fixtures truthfully; it is kept and
 * shown as LEGACY standings, never rewritten.
 *
 * Pure: no database, network or UI.
 */

export type TeamScore = { teamNumber: number; score: number };
/** teamA < teamB always; scoreA belongs to teamA. */
export type Fixture = { teamA: number; teamB: number; scoreA: number; scoreB: number };
export type MatchResultData = { kind: "fixtures"; fixtures: Fixture[] } | { kind: "legacy_standings"; teams: TeamScore[] };
export type FixtureOutcome = "W" | "D" | "L";

export const FIXTURES_FORMAT = "fixtures-v1";
export const MAX_SCORE = 999;

const isScore = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_SCORE;
const isTeam = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/** Distinct team numbers, ascending. */
export function normalizeTeamNumbers(teamNumbers: number[]): number[] {
  return [...new Set(teamNumbers.filter(isTeam))].sort((a, b) => a - b);
}

/** N × (N − 1) / 2 */
export function fixtureCount(teamCount: number): number {
  return teamCount < 2 ? 0 : (teamCount * (teamCount - 1)) / 2;
}

/**
 * Every unordered pair exactly once, in one deterministic order: by the
 * lower team number, then the higher (2 teams: [1,2]; 3: [1,2],[1,3],[2,3];
 * 4: [1,2],[1,3],[1,4],[2,3],[2,4],[3,4]).
 */
export function fixturePairs(teamNumbers: number[]): Array<[number, number]> {
  const t = normalizeTeamNumbers(teamNumbers);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) pairs.push([t[i], t[j]]);
  return pairs;
}

export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** teamA < teamB (scores swapped with their teams). */
function oriented(f: Fixture): Fixture {
  return f.teamA < f.teamB ? f : { teamA: f.teamB, teamB: f.teamA, scoreA: f.scoreB, scoreB: f.scoreA };
}

const byPair = (a: Fixture, b: Fixture) => a.teamA - b.teamA || a.teamB - b.teamB;

/** Stored result → model. Never throws; unusable data → null. */
export function parseResult(json: string | null | undefined): MatchResultData | null {
  let v: unknown;
  try {
    v = JSON.parse(json ?? "null");
  } catch {
    return null;
  }
  if (Array.isArray(v)) {
    const teams = v
      .filter((s) => isTeam(s?.teamNumber) && Number.isInteger(s?.score))
      .map((s) => ({ teamNumber: s.teamNumber as number, score: s.score as number }))
      .sort((a, b) => a.teamNumber - b.teamNumber);
    if (teams.length < 2 || new Set(teams.map((t) => t.teamNumber)).size !== teams.length) return null;
    if (teams.length === 2) {
      return { kind: "fixtures", fixtures: [{ teamA: teams[0].teamNumber, teamB: teams[1].teamNumber, scoreA: teams[0].score, scoreB: teams[1].score }] };
    }
    return { kind: "legacy_standings", teams };
  }
  if (v && typeof v === "object" && (v as { format?: unknown }).format === FIXTURES_FORMAT && Array.isArray((v as { fixtures?: unknown }).fixtures)) {
    const seen = new Set<string>();
    const fixtures: Fixture[] = [];
    for (const raw of (v as { fixtures: unknown[] }).fixtures) {
      const f = raw as Partial<Fixture> | null;
      if (!f || !isTeam(f.teamA) || !isTeam(f.teamB) || f.teamA === f.teamB || !Number.isInteger(f.scoreA) || !Number.isInteger(f.scoreB)) continue;
      const o = oriented(f as Fixture);
      const k = pairKey(o.teamA, o.teamB);
      if (seen.has(k)) continue;
      seen.add(k);
      fixtures.push(o);
    }
    return fixtures.length ? { kind: "fixtures", fixtures: fixtures.sort(byPair) } : null;
  }
  return null;
}

/** Canonical storage string. One fixture → the historical two-team array, byte for byte. */
export function serializeFixtures(fixtures: Fixture[]): string {
  const sorted = fixtures.map(oriented).sort(byPair);
  if (sorted.length === 1) {
    const f = sorted[0];
    return JSON.stringify([
      { teamNumber: f.teamA, score: f.scoreA },
      { teamNumber: f.teamB, score: f.scoreB },
    ]);
  }
  return JSON.stringify({ format: FIXTURES_FORMAT, fixtures: sorted.map((f) => ({ teamA: f.teamA, teamB: f.teamB, scoreA: f.scoreA, scoreB: f.scoreB })) });
}

export type FixtureInput = { teamA: number; teamB: number; scoreA: number; scoreB: number };

/**
 * Server-side validation of a submitted result against the PUBLISHED team
 * set: every pair exactly once, nothing else. Rejects teams outside the
 * match, a team playing itself, duplicate pairs (in either order), missing
 * fixtures and impossible scores. Returns fixtures in canonical order.
 */
export function validateFixtures(teamNumbers: number[], input: FixtureInput[]): { ok: true; fixtures: Fixture[] } | { ok: false; error: string } {
  const teams = normalizeTeamNumbers(teamNumbers);
  if (teams.length < 2) return { ok: false, error: "Publish the teams for this match first." };
  const allowed = new Set(teams);
  const seen = new Set<string>();
  const fixtures: Fixture[] = [];
  for (const f of input) {
    if (!isTeam(f.teamA) || !isTeam(f.teamB) || !allowed.has(f.teamA) || !allowed.has(f.teamB)) return { ok: false, error: "Every fixture must be between two of this match's published teams." };
    if (f.teamA === f.teamB) return { ok: false, error: "A team can't play itself." };
    if (!isScore(f.scoreA) || !isScore(f.scoreB)) return { ok: false, error: `Scores must be whole numbers from 0 to ${MAX_SCORE}.` };
    const o = oriented(f);
    const k = pairKey(o.teamA, o.teamB);
    if (seen.has(k)) return { ok: false, error: `Team ${o.teamA} vs Team ${o.teamB} was entered more than once.` };
    seen.add(k);
    fixtures.push(o);
  }
  const missing = fixturePairs(teams).filter(([a, b]) => !seen.has(pairKey(a, b)));
  if (missing.length) return { ok: false, error: `Enter a score for every fixture (missing: ${missing.map(([a, b]) => `Team ${a} vs Team ${b}`).join(", ")}).` };
  return { ok: true, fixtures: fixtures.sort(byPair) };
}

/** A stored result covers exactly the published team set's fixtures (publish precondition). */
export function isCompleteFor(result: MatchResultData | null, teamNumbers: number[]): boolean {
  if (!result || result.kind !== "fixtures") return false;
  const expected = fixturePairs(teamNumbers).map(([a, b]) => pairKey(a, b));
  const got = result.fixtures.map((f) => pairKey(f.teamA, f.teamB));
  return expected.length > 0 && expected.length === got.length && expected.every((k) => got.includes(k));
}

/** The winning team number of one fixture, or null for a draw. */
export function fixtureWinner(f: Fixture): number | null {
  return f.scoreA === f.scoreB ? null : f.scoreA > f.scoreB ? f.teamA : f.teamB;
}

/** "Team 1 5–3 Team 2" */
export function fixtureLine(f: Fixture): string {
  return `Team ${f.teamA} ${f.scoreA}–${f.scoreB} Team ${f.teamB}`;
}

/** One team's own fixtures: opponent, its score first, and W/D/L per fixture (never an invented overall result). */
export function teamFixtureRecord(result: MatchResultData | null, teamNumber: number): Array<{ opponent: number; scoreFor: number; scoreAgainst: number; outcome: FixtureOutcome }> {
  if (!result || result.kind !== "fixtures") return [];
  return result.fixtures
    .filter((f) => f.teamA === teamNumber || f.teamB === teamNumber)
    .map((f) => {
      const mineA = f.teamA === teamNumber;
      const scoreFor = mineA ? f.scoreA : f.scoreB;
      const scoreAgainst = mineA ? f.scoreB : f.scoreA;
      return { opponent: mineA ? f.teamB : f.teamA, scoreFor, scoreAgainst, outcome: scoreFor > scoreAgainst ? "W" : scoreFor < scoreAgainst ? "L" : "D" };
    });
}

/** Readable lines for any result (fixtures, or labeled legacy standings). */
export function resultLines(result: MatchResultData): string[] {
  return result.kind === "fixtures" ? result.fixtures.map(fixtureLine) : result.teams.map((t) => `Team ${t.teamNumber}: ${t.score}`);
}
