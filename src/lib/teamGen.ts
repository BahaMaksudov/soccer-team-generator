import type { Player, Rating, Position } from "@prisma/client";

const ratingWeight: Record<Rating, number> = {
  FAIR: 1,
  GOOD: 2,
  VERY_GOOD: 3,
  EXCELLENT: 4,
};

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Team = { teamNumber: number; players: Player[]; score: number };

export function generateBalancedTeams(players: Player[], teamCount: number) {
  if (teamCount < 2) throw new Error("Number of teams must be at least 2.");
  if (players.length < teamCount) throw new Error("Not enough players for that many teams.");

  const teams: Team[] = Array.from({ length: teamCount }, (_, i) => ({
    teamNumber: i + 1,
    players: [],
    score: 0,
  }));

  const GOALKEEPER: Position = "GOALKEEPER";

  // Step 1: assign goalkeepers (1 per team if possible)
  const gks = players.filter((p) => p.position === GOALKEEPER);
  const others = players.filter((p) => p.position !== GOALKEEPER);

  if (gks.length >= teamCount) {
    const gkSorted = shuffle(gks).sort((a, b) => ratingWeight[b.rating] - ratingWeight[a.rating]);
    const teamOrder = shuffle(teams.map((t) => t.teamNumber));
    for (let i = 0; i < teamCount; i++) {
      const team = teams.find((t) => t.teamNumber === teamOrder[i])!;
      const gk = gkSorted[i];
      team.players.push(gk);
      team.score += ratingWeight[gk.rating];
    }
  }

  const usedGKIds = new Set(teams.flatMap((t) => t.players.map((p) => p.id)));
  const remaining = [...others, ...gks.filter((gk) => !usedGKIds.has(gk.id))];

  // Step 2: distribute remaining by rating (strongest first to lowest-score team)
  const sorted = shuffle(remaining).sort((a, b) => ratingWeight[b.rating] - ratingWeight[a.rating]);
  for (const p of sorted) {
    const minScore = Math.min(...teams.map((t) => t.score));
    const candidates = teams.filter((t) => t.score === minScore);
    const team = candidates[Math.floor(Math.random() * candidates.length)];
    team.players.push(p);
    team.score += ratingWeight[p.rating];
  }

  return teams.map(({ score, ...t }) => t);
}
