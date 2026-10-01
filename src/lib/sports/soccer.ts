import type { SportDefinition } from "./types";

/**
 * Soccer — the production compatibility contract. Role keys, weights,
 * the goalkeeper SEED rule and the stamina coefficient reproduce the
 * pre-M7 generator exactly (see the soccer parity test).
 */
export const soccer: SportDefinition = {
  key: "soccer",
  version: 1,
  label: "Soccer",
  roles: [
    { key: "GOALKEEPER", label: "Goalkeeper", pluralLabel: "Goalkeepers", defaultWeight: 2 },
    { key: "DEFENDER", label: "Defender", pluralLabel: "Defenders", defaultWeight: 1 },
    { key: "MIDFIELDER", label: "Midfielder", pluralLabel: "Midfielders", defaultWeight: 2 },
    { key: "FORWARD", label: "Forward", pluralLabel: "Forwards", defaultWeight: 2 },
    { key: "ANY", label: "Any", pluralLabel: "Any", defaultWeight: 2 },
  ],
  defaultRoleKey: "ANY",
  // Pre-M7 the Add Player form started at Midfielder; kept so the soccer UX is unchanged.
  newPlayerRoleKey: "MIDFIELDER",
  roleRules: [{ roleKey: "GOALKEEPER", perTeam: 1, mode: "SEED", warnWhenShort: true }],
  defaults: { staminaCoef: 1 },
  terminology: { roleNoun: "Position" },
  messaging: { emoji: "⚽", gameNoun: "game", resultLabel: "Final score" },
  resultFormat: { kind: "POINTS", label: "goals" },
  typicalPlayersPerTeam: { min: 5, max: 11, preferred: 7 },
};
