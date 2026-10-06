import { getStamina, SKILL_WEIGHT, type SkillRating } from "@/lib/balanceEngine";

/**
 * M9.2 — the displayed 0.0–10.0 Player Rating, derived from the SAME
 * strength terms the balance engine scores players with
 * (src/lib/balanceEngine.ts impactScore):
 *
 *     impact = skill×10 + stamina×2×staminaCoef + roleWeight×3
 *
 * The rating keeps the two PERSONAL terms and drops the role term, so a
 * role name alone never makes one player "better" than another (roles stay a
 * team-composition concern — M8.1). It is the personal strength scaled
 * linearly between the weakest and the strongest possible player of the
 * Group's configuration:
 *
 *     strength = skill×10 + stamina×2×c         (c = max(0, staminaCoef))
 *     min      = 1×10 + 1×2×c                   (FAIR, stamina 1)
 *     max      = 4×10 + 5×2×c                   (EXCELLENT, stamina 5)
 *     rating   = round(10 × (strength − min) / (max − min), 1 decimal)
 *
 * Deterministic, bounded to [0, 10], computed on read from authoritative
 * fields (never stored, so it cannot go stale). For any fixed role and
 * configuration, ordering players by rating is ordering them by impact.
 * Organizer-only: it is derived from skill and stamina.
 */
export function playerRating(player: { rating: string; stamina?: number | null }, staminaCoef: number): number {
  const c = Number.isFinite(staminaCoef) ? Math.max(0, staminaCoef) : 0;
  const skill = SKILL_WEIGHT[player.rating as SkillRating] ?? SKILL_WEIGHT.GOOD;
  const strength = skill * 10 + getStamina(player) * 2 * c;
  const min = SKILL_WEIGHT.FAIR * 10 + 1 * 2 * c;
  const max = SKILL_WEIGHT.EXCELLENT * 10 + 5 * 2 * c;
  const scaled = (10 * (strength - min)) / (max - min);
  return Math.round(Math.min(10, Math.max(0, scaled)) * 10) / 10;
}

/** "7.4" — always one decimal. */
export const formatPlayerRating = (r: number) => r.toFixed(1);
