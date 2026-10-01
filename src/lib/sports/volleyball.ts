import type { SportDefinition } from "./types";

/** Volleyball — setters are spread one per team when possible; a shortage only warns. */
export const volleyball: SportDefinition = {
  key: "volleyball",
  version: 1,
  label: "Volleyball",
  roles: [
    { key: "SETTER", label: "Setter", pluralLabel: "Setters", defaultWeight: 2 },
    { key: "HITTER", label: "Hitter", pluralLabel: "Hitters", defaultWeight: 2 },
    { key: "MIDDLE", label: "Middle", pluralLabel: "Middles", defaultWeight: 2 },
    { key: "LIBERO", label: "Libero / Defender", pluralLabel: "Liberos / Defenders", defaultWeight: 2 },
    { key: "ALL_AROUND", label: "All-around", pluralLabel: "All-around players", defaultWeight: 2 },
  ],
  defaultRoleKey: "ALL_AROUND",
  roleRules: [{ roleKey: "SETTER", perTeam: 1, mode: "SPREAD", warnWhenShort: true }],
  defaults: { staminaCoef: 0.5 },
  terminology: { roleNoun: "Role" },
  messaging: { emoji: "🏐", gameNoun: "match", resultLabel: "Match result" },
  resultFormat: { kind: "SETS", bestOf: 3, pointsPerSet: 25 },
  typicalPlayersPerTeam: { min: 4, max: 6, preferred: 6 },
};
