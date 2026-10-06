import { describe, it, expect } from "vitest";
import {
  FIXTURES_FORMAT,
  fixtureCount,
  fixtureLine,
  fixturePairs,
  fixtureWinner,
  isCompleteFor,
  pairKey,
  parseResult,
  resultLines,
  serializeFixtures,
  teamFixtureRecord,
  validateFixtures,
} from "@/lib/matchResults";
import { buildRecapFacts, contradictsFacts, deterministicRecap, isFixtureSet, unsupportedClaims } from "@/lib/recap";
import { renderSummaryMessage, summaryDeliveryHashes } from "@/lib/messaging/postGameMessages";
import { publishedPostGame, resultView } from "@/lib/postGame";

/**
 * M8.1 — pairwise fixture results. N teams → N × (N − 1) / 2 fixtures, each
 * with two independent scores; historical two-team rows keep working
 * byte-for-byte; pre-M8.1 per-team rows for 3+ teams are kept as labeled
 * legacy standings (never rewritten, never shown as "5 – 3 – 2").
 */

const THREE = [
  { teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 },
  { teamA: 2, teamB: 3, scoreA: 4, scoreB: 2 },
  { teamA: 1, teamB: 3, scoreA: 3, scoreB: 3 },
];

describe("fixtures: every unordered pair exactly once", () => {
  it.each([
    [2, 1, [[1, 2]]],
    [3, 3, [[1, 2], [1, 3], [2, 3]]],
    [4, 6, [[1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]],
  ])("%i teams → %i fixtures", (n, count, pairs) => {
    const teams = Array.from({ length: n }, (_, i) => i + 1);
    expect(fixtureCount(n)).toBe(count);
    expect(fixturePairs(teams)).toEqual(pairs);
    const keys = fixturePairs(teams).map(([a, b]) => pairKey(a, b));
    expect(new Set(keys).size).toBe(keys.length);
    expect(fixturePairs([...teams].reverse())).toEqual(pairs); // deterministic regardless of input order
  });
  it("5 teams → 10 fixtures; fewer than 2 teams → none", () => {
    expect(fixturePairs([1, 2, 3, 4, 5])).toHaveLength(10);
    expect(fixturePairs([1])).toEqual([]);
    expect(fixtureCount(1)).toBe(0);
  });
});

describe("server-side validation against the published team set", () => {
  it("accepts a complete set (any order / orientation) and returns it canonically", () => {
    const r = validateFixtures([1, 2, 3], [THREE[1], { teamA: 3, teamB: 1, scoreA: 3, scoreB: 3 }, { teamA: 2, teamB: 1, scoreA: 3, scoreB: 5 }]);
    expect(r).toEqual({
      ok: true,
      fixtures: [
        { teamA: 1, teamB: 2, scoreA: 5, scoreB: 3 },
        { teamA: 1, teamB: 3, scoreA: 3, scoreB: 3 },
        { teamA: 2, teamB: 3, scoreA: 4, scoreB: 2 },
      ],
    });
  });
  it("rejects duplicate pairs (also reversed), foreign teams, self-play, impossible scores and missing fixtures", () => {
    const bad = (input: Parameters<typeof validateFixtures>[1], match: RegExp) => {
      const r = validateFixtures([1, 2, 3], input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(match);
    };
    bad([...THREE, { teamA: 2, teamB: 1, scoreA: 0, scoreB: 0 }], /more than once/);
    bad([THREE[0], THREE[1], { teamA: 1, teamB: 4, scoreA: 1, scoreB: 0 }], /published teams/);
    bad([THREE[0], THREE[1], { teamA: 3, teamB: 3, scoreA: 1, scoreB: 0 }], /itself/);
    bad([THREE[0], THREE[1], { teamA: 1, teamB: 3, scoreA: -1, scoreB: 0 }], /whole numbers/);
    bad([THREE[0], THREE[1], { teamA: 1, teamB: 3, scoreA: 1000, scoreB: 0 }], /whole numbers/);
    bad([THREE[0], THREE[1], { teamA: 1, teamB: 3, scoreA: 1.5, scoreB: 0 }], /whole numbers/);
    bad([THREE[0], THREE[1]], /missing: Team 1 vs Team 3/);
    bad([], /missing/);
    expect(validateFixtures([1], [])).toMatchObject({ ok: false });
  });
  it("isCompleteFor: only a fixture set covering exactly the published teams' pairs is publishable", () => {
    const three = parseResult(serializeFixtures(THREE));
    expect(isCompleteFor(three, [1, 2, 3])).toBe(true);
    expect(isCompleteFor(three, [1, 2, 3, 4])).toBe(false); // teams were re-published with 4 teams
    expect(isCompleteFor(parseResult(serializeFixtures([THREE[0]])), [1, 2, 3])).toBe(false);
    expect(isCompleteFor(parseResult('[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3},{"teamNumber":3,"score":2}]'), [1, 2, 3])).toBe(false);
    expect(isCompleteFor(null, [1, 2])).toBe(false);
  });
});

describe("storage and historical compatibility", () => {
  it("two teams are stored EXACTLY in the historical format", () => {
    expect(serializeFixtures([{ teamA: 2, teamB: 1, scoreA: 3, scoreB: 5 }])).toBe('[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3}]');
  });
  it("3+ teams use the versioned fixtures format and round-trip", () => {
    const json = serializeFixtures(THREE);
    expect(JSON.parse(json).format).toBe(FIXTURES_FORMAT);
    expect(parseResult(json)).toEqual({ kind: "fixtures", fixtures: validateFixtures([1, 2, 3], THREE).ok ? (validateFixtures([1, 2, 3], THREE) as { fixtures: unknown }).fixtures : [] });
  });
  it("a historical two-team row reads as one fixture", () => {
    expect(parseResult('[{"teamNumber":2,"score":3},{"teamNumber":1,"score":7}]')).toEqual({ kind: "fixtures", fixtures: [{ teamA: 1, teamB: 2, scoreA: 7, scoreB: 3 }] });
  });
  it("a historical 3-team row (one score per team) is kept as labeled legacy standings — no invented fixtures", () => {
    const legacy = parseResult('[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3},{"teamNumber":3,"score":2}]');
    expect(legacy).toEqual({ kind: "legacy_standings", teams: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }, { teamNumber: 3, score: 2 }] });
    expect(resultLines(legacy!)).toEqual(["Team 1: 5", "Team 2: 3", "Team 3: 2"]);
  });
  it("unusable data never throws", () => {
    for (const bad of [null, "", "nope", "{}", "[]", '[{"teamNumber":1,"score":5}]', '{"format":"fixtures-v1","fixtures":[]}', '{"format":"other","fixtures":[{"teamA":1,"teamB":2,"scoreA":1,"scoreB":0}]}']) {
      expect(parseResult(bad)).toBeNull();
    }
  });
});

describe("outcomes: per fixture, never an invented overall result", () => {
  const r = parseResult(serializeFixtures(THREE))!;
  it("winner / draw per fixture, readable lines", () => {
    expect(THREE.map((f) => fixtureWinner(f))).toEqual([1, 2, null]);
    expect(resultLines(r)).toEqual(["Team 1 5–3 Team 2", "Team 1 3–3 Team 3", "Team 2 4–2 Team 3"]);
    expect(fixtureLine({ teamA: 1, teamB: 2, scoreA: 0, scoreB: 1 })).toBe("Team 1 0–1 Team 2");
  });
  it("a team's own record: its score first, W/D/L per fixture", () => {
    expect(teamFixtureRecord(r, 1)).toEqual([
      { opponent: 2, scoreFor: 5, scoreAgainst: 3, outcome: "W" },
      { opponent: 3, scoreFor: 3, scoreAgainst: 3, outcome: "D" },
    ]);
    expect(teamFixtureRecord(r, 2)).toEqual([
      { opponent: 1, scoreFor: 3, scoreAgainst: 5, outcome: "L" },
      { opponent: 3, scoreFor: 4, scoreAgainst: 2, outcome: "W" },
    ]);
    expect(teamFixtureRecord(parseResult('[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3},{"teamNumber":3,"score":2}]'), 1)).toEqual([]);
  });
  it("published view: fixtures with winners; legacy standings labeled; unpublished → nothing", () => {
    expect(resultView(r).fixtures.map((f) => f.winner)).toEqual([1, null, 2]);
    expect(resultView(r).legacyStandings).toBeNull();
    const row = (publishedAt: Date | null) => ({ result: { scoresJson: serializeFixtures(THREE), publishedAt }, mvp: null, recap: null });
    expect(publishedPostGame(row(null), null).result).toBeNull();
    expect(publishedPostGame(row(new Date()), null).result?.fixtures).toHaveLength(3);
    expect(JSON.stringify(publishedPostGame(row(new Date()), null))).not.toMatch(/5 – 3 – 2|"teams"/);
  });
});

describe("recap: every published fixture reaches the standard recap and the AI facts", () => {
  const facts = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", locationName: "Field 2", result: parseResult(serializeFixtures(THREE)), mvpNames: ["Ana"], participantCount: 18, ratings: "LEAK" })!;
  it("fixture facts (allow-listed), no overall winner", () => {
    expect(isFixtureSet(facts)).toBe(true);
    expect(facts).toEqual({
      sport: "Soccer",
      date: "2026-10-05",
      venue: "Field 2",
      fixtures: [
        { teams: ["Team 1", "Team 2"], score: "5–3", outcome: { kind: "WIN", winner: "Team 1" } },
        { teams: ["Team 1", "Team 3"], score: "3–3", outcome: { kind: "DRAW" } },
        { teams: ["Team 2", "Team 3"], score: "4–2", outcome: { kind: "WIN", winner: "Team 2" } },
      ],
      mvp: ["Ana"],
      participants: 18,
    });
    expect(JSON.stringify(facts)).not.toContain("LEAK");
  });
  it("standard recap states every fixture", () => {
    expect(deterministicRecap(facts)).toBe(
      "Team 1 beat Team 2 5–3, Team 1 drew with Team 3 3–3, and Team 2 beat Team 3 4–2. Player of the Match: Ana. Thanks to everyone who played!"
    );
  });
  it("AI guards: any fixture score (either order) is fine; an invented score or overall champion is not", () => {
    expect(contradictsFacts("Team 2 edged Team 3 4–2 after a 3-5 loss", facts)).toBe(false);
    expect(contradictsFacts("Team 1 won 6–1", facts)).toBe(true);
    expect(unsupportedClaims("Team 1 were crowned champions tonight", facts)).toBe("outcome");
    expect(unsupportedClaims("Team 1 beat Team 2 and drew with Team 3 — Player of the Match Ana!", facts)).toBeNull();
  });
  it("two teams: facts and standard recap unchanged from before M8.1", () => {
    const two = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", result: parseResult('[{"teamNumber":1,"score":7},{"teamNumber":2,"score":5}]') })!;
    const legacyInput = buildRecapFacts({ sportLabel: "Soccer", date: "2026-10-05", scores: [{ teamNumber: 1, score: 7 }, { teamNumber: 2, score: 5 }] })!;
    expect(two).toEqual(legacyInput);
    expect(deterministicRecap(two)).toBe("Team 1 beat Team 2, 7–5. Thanks to everyone who played!");
  });
});

describe("Match Summary (Telegram content; nothing is sent in tests)", () => {
  const plain = (html: string) => html.replace(/<[^>]+>/g, "");
  const base = { date: "2026-10-05", sportEmoji: "⚽", venue: null, mvpNames: [], recap: null };
  it("3 teams: every fixture on its own line; no overall winner line", () => {
    const m = renderSummaryMessage({ ...base, result: parseResult(serializeFixtures(THREE)) }, null);
    expect(plain(m.html)).toBe("🏁 MATCH COMPLETE — 10/5/26\n\n⚽ Team 1  5 — 3  Team 2\n⚽ Team 1  3 — 3  Team 3\n⚽ Team 2  4 — 2  Team 3");
  });
  it("2 teams via the new model: identical text AND delivery hash to the historical scores (a posted summary stays 'posted')", () => {
    const viaResult = renderSummaryMessage({ ...base, result: parseResult('[{"teamNumber":1,"score":5},{"teamNumber":2,"score":3}]') }, null);
    const viaScores = renderSummaryMessage({ ...base, scores: [{ teamNumber: 1, score: 5 }, { teamNumber: 2, score: 3 }] }, null);
    expect(viaResult.html).toBe(viaScores.html);
    expect(viaResult.contentHash).toBe(viaScores.contentHash);
    expect(plain(viaResult.html)).toContain("🏆 Team 1 wins!");
  });
  it("a changed fixture score changes the summary hash", () => {
    const a = summaryDeliveryHashes({ ...base, result: parseResult(serializeFixtures(THREE)) }).contentHash;
    const b = summaryDeliveryHashes({ ...base, result: parseResult(serializeFixtures([...THREE.slice(0, 2), { teamA: 1, teamB: 3, scoreA: 4, scoreB: 3 }])) }).contentHash;
    expect(a).not.toBe(b);
  });
});
