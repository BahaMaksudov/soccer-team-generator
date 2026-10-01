import type { SportDefinition } from "./types";

/** Other — any team sport: one generic role, balanced on skill and stamina only. */
export const other: SportDefinition = {
  key: "other",
  version: 1,
  label: "Other",
  roles: [{ key: "PLAYER", label: "Player", pluralLabel: "Players", defaultWeight: 2 }],
  defaultRoleKey: "PLAYER",
  roleRules: [],
  defaults: { staminaCoef: 1 },
  terminology: { roleNoun: "Role" },
  messaging: { emoji: "🏅", gameNoun: "game", resultLabel: "Result" },
  resultFormat: { kind: "POINTS", label: "points" },
};
