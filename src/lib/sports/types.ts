/**
 * M7 — Multi-Sport Foundation: the shape of a sport definition.
 *
 * Sport definitions are stable, versioned CODE (src/lib/sports/*), not
 * database rows: a Group stores only its immutable `sportKey`, and the
 * registry supplies roles, balancing rules, terminology, messaging
 * vocabulary and (for M9) the result format. Groups may override only
 * bounded knobs (role weights, stamina coefficient) via GroupSetting.
 *
 * Role keys are persisted in Player.position and in TeamGeneration
 * snapshots: once shipped, a role key is never renamed or reused — only
 * its label may change.
 */

/**
 * How the generator treats a role:
 *  - SEED   — strong: up to perTeam×teamCount players of the role are placed
 *             FIRST (strongest first, each onto the weakest team with room).
 *             Reproduces the historical soccer goalkeeper step exactly.
 *  - SPREAD — soft: role players keep their normal strongest-first turn,
 *             but at that turn prefer a team that still has fewer than
 *             perTeam of the role (weakest such team first); while role
 *             players remain unplaced, other players avoid taking such a
 *             team's last free slots (dropped if nowhere else has room).
 *  - IGNORE — no special distribution.
 * A shortage never fails generation; it becomes a ROLE_SHORTAGE warning.
 */
export type RoleRuleMode = "SEED" | "SPREAD" | "IGNORE";

export type RoleRule = {
  roleKey: string;
  perTeam: number;
  mode: RoleRuleMode;
  /** Emit ROLE_SHORTAGE when fewer than perTeam×teamCount are selected. */
  warnWhenShort: boolean;
};

export type SportRole = {
  key: string;
  label: string;
  /** For coverage lines such as "Goalkeepers: 2 available for 3 teams". */
  pluralLabel: string;
  /** Default role weight in the impact score (roleWeight × 3). */
  defaultWeight: number;
};

/** M9 preparation only — declares how a result is expressed; nothing consumes it yet. */
export type ResultFormat =
  | { kind: "POINTS"; label: string }
  | { kind: "SETS"; bestOf: 3 | 5; pointsPerSet?: number };

export type SportDefinition = {
  key: string;
  version: number;
  label: string;
  roles: SportRole[];
  /** Fallback role for unknown/legacy role keys and the generic "any" role. */
  defaultRoleKey: string;
  /** Pre-selected role in the Add Player form (defaults to defaultRoleKey). */
  newPlayerRoleKey?: string;
  roleRules: RoleRule[];
  defaults: { staminaCoef: number };
  terminology: { roleNoun: "Position" | "Role" };
  messaging: { emoji: string; gameNoun: string; resultLabel: string };
  resultFormat: ResultFormat;
  /** Informational only — never a constraint (pickup games vary). */
  typicalPlayersPerTeam?: { min?: number; max?: number; preferred?: number };
};

/** The serializable subset client components need (labels and options only). */
export type SportClientView = Pick<
  SportDefinition,
  "key" | "label" | "roles" | "newPlayerRoleKey" | "defaultRoleKey" | "roleRules" | "terminology" | "defaults"
>;
