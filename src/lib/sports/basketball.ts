import type { SportDefinition } from "./types";

/** Basketball — pickup roles; Bigs are spread (never required). No goalkeeper concept. */
export const basketball: SportDefinition = {
  key: "basketball",
  version: 1,
  label: "Basketball",
  roles: [
    { key: "GUARD", label: "Guard", pluralLabel: "Guards", defaultWeight: 2 },
    { key: "WING", label: "Wing", pluralLabel: "Wings", defaultWeight: 2 },
    { key: "BIG", label: "Big", pluralLabel: "Bigs", defaultWeight: 2 },
    { key: "ANY", label: "Any", pluralLabel: "Any", defaultWeight: 2 },
  ],
  defaultRoleKey: "ANY",
  roleRules: [{ roleKey: "BIG", perTeam: 1, mode: "SPREAD", warnWhenShort: false }],
  defaults: { staminaCoef: 1 },
  terminology: { roleNoun: "Role" },
  messaging: { emoji: "🏀", gameNoun: "game", resultLabel: "Final score" },
  resultFormat: { kind: "POINTS", label: "points" },
  typicalPlayersPerTeam: { min: 3, max: 5, preferred: 5 },
};
