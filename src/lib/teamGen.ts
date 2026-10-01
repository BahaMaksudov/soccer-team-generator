import type { Player } from "@prisma/client";
import type { BalanceWeights } from "@/lib/scoring";
import { generateTeams, resolveBalanceConfig } from "@/lib/balanceEngine";
import { soccer } from "@/lib/sports/soccer";

/**
 * Everything the generator needs from a player: enough to score them, a
 * stable id, and a name carried through for display. Deliberately NOT the
 * full Prisma `Player` (no Telegram BigInt fields can reach a response).
 */
export type GeneratorPlayer = Pick<Player, "id" | "firstName" | "lastName" | "rating" | "position" | "stamina">;

/**
 * M7 — SOCCER COMPATIBILITY WRAPPER. Production generation goes through
 * the sport-neutral engine (src/lib/balanceEngine.ts) with the Group's
 * SportDefinition; this keeps the pre-M7 signature for existing callers
 * and tests and is exactly the engine with the soccer definition (the
 * goalkeeper behavior lives in soccer's SEED rule, not here).
 *
 * `format` (6|7|8) is deprecated and ignored, as it always was.
 */
export function generateBalancedTeams(
  players: GeneratorPlayer[],
  teamCount: number,
  _format?: 6 | 7 | 8,
  weights?: BalanceWeights,
  rng: () => number = Math.random
): Array<{ teamNumber: number; players: GeneratorPlayer[] }> {
  return generateTeams({ players, teamCount, sport: soccer, config: resolveBalanceConfig(soccer, weights), rng }).teams;
}
