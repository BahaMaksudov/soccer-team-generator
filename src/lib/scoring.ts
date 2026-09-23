import type { Player, Position, Rating } from "@prisma/client";

/**
 * Single source of truth for player balancing math.
 *
 * Both the server (src/lib/teamGen.ts) and the Admin UI's displayed
 * "Score" column must call getPlayerImpactScore() from here so the
 * number an admin sees always matches what the generator actually used.
 *
 * Defaults below are chosen to exactly reproduce the app's historical
 * hardcoded formula (rating*10 + stamina*2 + positionWeight*3, with
 * DEFENDER=1 and everyone else=2) so wiring up configurable weights
 * does not change existing generation behavior until an admin changes
 * a setting away from its default.
 */

export const RATING_WEIGHT: Record<Rating, number> = {
  FAIR: 1,
  GOOD: 2,
  VERY_GOOD: 3,
  EXCELLENT: 4,
};

export type PositionWeights = Partial<Record<Position, number>>;

export type BalanceWeights = {
  staminaCoef?: number;
  positionWeights?: PositionWeights;
};

export const DEFAULT_POSITION_WEIGHTS: Record<Position, number> = {
  GOALKEEPER: 2,
  DEFENDER: 1,
  MIDFIELDER: 2,
  FORWARD: 2,
};

export const DEFAULT_BALANCE_WEIGHTS: Required<BalanceWeights> = {
  staminaCoef: 1,
  positionWeights: DEFAULT_POSITION_WEIGHTS,
};

const MIN_STAMINA = 1;
const MAX_STAMINA = 5;
const DEFAULT_STAMINA = 3;

export function getStamina(p: { stamina?: number | null }): number {
  const n = Number(p?.stamina);
  return Number.isFinite(n) ? Math.min(MAX_STAMINA, Math.max(MIN_STAMINA, n)) : DEFAULT_STAMINA;
}

/**
 * Merge partial/malformed stored weights with safe defaults.
 * Never throws — bad or missing settings fall back to defaults field-by-field.
 */
export function mergeBalanceWeights(input?: unknown): Required<BalanceWeights> {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<BalanceWeights>;

  const staminaCoefRaw = Number((raw as Record<string, unknown>)?.staminaCoef);
  const staminaCoef = Number.isFinite(staminaCoefRaw)
    ? staminaCoefRaw
    : DEFAULT_BALANCE_WEIGHTS.staminaCoef;

  const rawPositionWeights =
    raw?.positionWeights && typeof raw.positionWeights === "object" ? raw.positionWeights : {};

  const positionWeights = { ...DEFAULT_POSITION_WEIGHTS };
  for (const key of Object.keys(DEFAULT_POSITION_WEIGHTS) as Position[]) {
    const v = Number((rawPositionWeights as Record<string, unknown>)?.[key]);
    if (Number.isFinite(v)) positionWeights[key] = v;
  }

  return { staminaCoef, positionWeights };
}

/**
 * A player's balancing "impact score". Higher = stronger contributor.
 * rating dominates; stamina and position are smaller modifiers.
 */
export function getPlayerImpactScore(
  player: { rating: Rating; position: Position; stamina?: number | null },
  weights?: BalanceWeights
): number {
  const W = mergeBalanceWeights(weights);
  const rating = RATING_WEIGHT[player.rating] ?? 2;
  const stamina = getStamina(player);
  const positionWeight = W.positionWeights[player.position] ?? 1;
  return rating * 10 + stamina * 2 * W.staminaCoef + positionWeight * 3;
}

export type ScorablePlayer = Pick<Player, "rating" | "position" | "stamina">;
