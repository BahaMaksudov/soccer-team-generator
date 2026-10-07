import { describe, it, expect } from "vitest";
import { impactScore, resolveBalanceConfig, type EnginePlayer } from "@/lib/balanceEngine";
import { formatPlayerRating, playerRating } from "@/lib/playerRating";
import { soccer } from "@/lib/sports/soccer";
import { findSport } from "@/lib/sports";

/** M9.2 — the 0–10 Player Rating is the balance engine's personal strength, scaled. */
const RATINGS = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;
const all: EnginePlayer[] = RATINGS.flatMap((rating) => [1, 2, 3, 4, 5].map((stamina) => ({ id: `${rating}-${stamina}`, rating, stamina, position: "MIDFIELDER" })));

describe("Player Rating 0.0–10.0", () => {
  it("bounds: weakest = 0.0, strongest = 10.0; always one decimal; deterministic", () => {
    expect(playerRating({ rating: "FAIR", stamina: 1 }, 1)).toBe(0);
    expect(playerRating({ rating: "EXCELLENT", stamina: 5 }, 1)).toBe(10);
    for (const p of all) {
      const r = playerRating(p, 1);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(10);
      expect(Math.round(r * 10)).toBe(r * 10);
      expect(playerRating(p, 1)).toBe(r);
      expect(formatPlayerRating(r)).toMatch(/^\d{1,2}\.\d$/);
    }
  });
  it("the documented formula (soccer defaults, staminaCoef 1)", () => {
    // strength = skill×10 + stamina×2; min 12, max 50 → GOOD/3 = 26 → 10×14/38 = 3.684… → 3.7
    expect(playerRating({ rating: "GOOD", stamina: 3 }, 1)).toBe(3.7);
    expect(playerRating({ rating: "VERY_GOOD", stamina: 4 }, 1)).toBe(6.8); // 38 → 10×26/38
  });
  it("ordering matches the balance engine's impact for any role and configuration (rating never reorders players)", () => {
    for (const sport of [soccer, findSport("basketball")!, findSport("volleyball")!]) {
      for (const stored of [undefined, { staminaCoef: 2.5 }, { staminaCoef: 0 }, { staminaCoef: 0.5, positionWeights: { DEFENDER: 9 } }]) {
        const config = resolveBalanceConfig(sport, stored);
        const role = sport.roles[0].key;
        const players = all.map((p) => ({ ...p, position: role }));
        for (const a of players)
          for (const b of players) {
            const ia = impactScore(sport, config, a);
            const ib = impactScore(sport, config, b);
            const ra = playerRating(a, config.staminaCoef);
            const rb = playerRating(b, config.staminaCoef);
            if (ia > ib + 1e-9) expect(ra).toBeGreaterThanOrEqual(rb); // rounding may tie, never invert
          }
      }
    }
  });
  it("a role name alone never changes the rating (roles are a composition concern)", () => {
    const config = resolveBalanceConfig(soccer, { positionWeights: { GOALKEEPER: 10, DEFENDER: 0 } });
    expect(playerRating({ rating: "GOOD", stamina: 3 }, config.staminaCoef)).toBe(playerRating({ rating: "GOOD", stamina: 3 }, config.staminaCoef));
    expect(impactScore(soccer, config, { id: "a", rating: "GOOD", stamina: 3, position: "GOALKEEPER" })).not.toBe(impactScore(soccer, config, { id: "b", rating: "GOOD", stamina: 3, position: "DEFENDER" }));
  });
  it("stamina coefficient 0 → skill alone; a negative stored coefficient is treated as 0", () => {
    expect(playerRating({ rating: "GOOD", stamina: 1 }, 0)).toBe(playerRating({ rating: "GOOD", stamina: 5 }, 0));
    expect(playerRating({ rating: "VERY_GOOD", stamina: 2 }, -3)).toBe(playerRating({ rating: "VERY_GOOD", stamina: 2 }, 0));
  });
});
