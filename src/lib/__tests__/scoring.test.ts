import { describe, it, expect } from "vitest";
import { getPlayerImpactScore, mergeBalanceWeights, getStamina } from "../scoring";

describe("mergeBalanceWeights", () => {
  it("returns safe defaults for undefined input", () => {
    const w = mergeBalanceWeights(undefined);
    expect(w.staminaCoef).toBe(1);
    expect(w.positionWeights.DEFENDER).toBe(1);
    expect(w.positionWeights.GOALKEEPER).toBe(2);
  });

  it("never throws on malformed input", () => {
    expect(() => mergeBalanceWeights(null)).not.toThrow();
    expect(() => mergeBalanceWeights("garbage")).not.toThrow();
    expect(() => mergeBalanceWeights(42)).not.toThrow();
    expect(() => mergeBalanceWeights({ positionWeights: "nope" })).not.toThrow();
    expect(() => mergeBalanceWeights({ staminaCoef: "NaN-ish" })).not.toThrow();
  });

  it("falls back field-by-field rather than all-or-nothing", () => {
    const w = mergeBalanceWeights({ staminaCoef: 2.5 });
    expect(w.staminaCoef).toBe(2.5);
    expect(w.positionWeights.DEFENDER).toBe(1); // untouched field still defaults
  });

  it("merges a partial positionWeights object with defaults for missing keys", () => {
    const w = mergeBalanceWeights({ positionWeights: { DEFENDER: 9 } });
    expect(w.positionWeights.DEFENDER).toBe(9);
    expect(w.positionWeights.MIDFIELDER).toBe(2); // still default
  });
});

describe("getStamina", () => {
  it("clamps to the 1..5 range", () => {
    expect(getStamina({ stamina: 0 })).toBe(1);
    expect(getStamina({ stamina: 9 })).toBe(5);
    expect(getStamina({ stamina: 3 })).toBe(3);
  });

  it("defaults to 3 for missing/non-numeric values", () => {
    expect(getStamina({})).toBe(3);
    expect(getStamina({ stamina: Number.NaN })).toBe(3);
  });

  it("clamps null to 1 rather than defaulting to 3 (Number(null) is 0, a finite value) — inherited unchanged from the original implementation", () => {
    expect(getStamina({ stamina: null })).toBe(1);
  });
});

describe("getPlayerImpactScore", () => {
  it("at default weights, exactly reproduces the app's historical hardcoded formula", () => {
    // Historical formula: rating*10 + stamina*2 + positionWeight*3,
    // where positionWeight was DEFENDER=1, everyone else=2.
    const defender = { rating: "GOOD" as const, position: "DEFENDER" as const, stamina: 4 };
    const midfielder = { rating: "EXCELLENT" as const, position: "MIDFIELDER" as const, stamina: 2 };

    expect(getPlayerImpactScore(defender)).toBe(2 * 10 + 4 * 2 + 1 * 3); // 31
    expect(getPlayerImpactScore(midfielder)).toBe(4 * 10 + 2 * 2 + 2 * 3); // 50
  });

  it("higher rating always produces a higher score, all else equal", () => {
    const base = { position: "MIDFIELDER" as const, stamina: 3 };
    const fair = getPlayerImpactScore({ ...base, rating: "FAIR" });
    const good = getPlayerImpactScore({ ...base, rating: "GOOD" });
    const veryGood = getPlayerImpactScore({ ...base, rating: "VERY_GOOD" });
    const excellent = getPlayerImpactScore({ ...base, rating: "EXCELLENT" });
    expect(fair).toBeLessThan(good);
    expect(good).toBeLessThan(veryGood);
    expect(veryGood).toBeLessThan(excellent);
  });

  it("respects a custom staminaCoef", () => {
    const player = { rating: "GOOD" as const, position: "MIDFIELDER" as const, stamina: 5 };
    const low = getPlayerImpactScore(player, { staminaCoef: 0 });
    const high = getPlayerImpactScore(player, { staminaCoef: 5 });
    expect(high).toBeGreaterThan(low);
  });
});
