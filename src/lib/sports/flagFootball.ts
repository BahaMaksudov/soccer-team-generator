import type { SportDefinition } from "./types";

/**
 * Flag Football — the initial recreational American-football option.
 * Quarterbacks are spread one per team when possible; a shortage only
 * warns. A future tackle `american_football` is a separate definition.
 */
export const flagFootball: SportDefinition = {
  key: "flag_football",
  version: 1,
  label: "Flag Football",
  roles: [
    { key: "QUARTERBACK", label: "Quarterback", pluralLabel: "Quarterbacks", defaultWeight: 2 },
    { key: "RECEIVER", label: "Receiver", pluralLabel: "Receivers", defaultWeight: 2 },
    { key: "RUSHER_LINE", label: "Rusher / Line", pluralLabel: "Rushers / Linemen", defaultWeight: 2 },
    { key: "DEFENDER", label: "Defender", pluralLabel: "Defenders", defaultWeight: 2 },
    { key: "ATHLETE", label: "Athlete / Any", pluralLabel: "Athletes", defaultWeight: 2 },
  ],
  defaultRoleKey: "ATHLETE",
  roleRules: [{ roleKey: "QUARTERBACK", perTeam: 1, mode: "SPREAD", warnWhenShort: true }],
  defaults: { staminaCoef: 1 },
  terminology: { roleNoun: "Role" },
  messaging: { emoji: "🏈", gameNoun: "game", resultLabel: "Final score" },
  resultFormat: { kind: "POINTS", label: "points" },
  typicalPlayersPerTeam: { min: 5, max: 8, preferred: 7 },
};
