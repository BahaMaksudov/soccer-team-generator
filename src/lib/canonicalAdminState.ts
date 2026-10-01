import type { PublishedGeneration } from "@/lib/closeAndPostUi";
import { rosterRoleCoverage, type RoleCoverage, type SportRules } from "@/lib/balanceEngine";

/**
 * Phase 2D.6D.5E.3 — pure, framework-free helpers for canonical Admin
 * Player/Generate state (this repo's vitest runs in node with no React
 * renderer — same approach as telegramImportSelection.ts and
 * closeAndPostUi.ts). UX only; every rule here is re-enforced
 * server-side (playerCreateSchema/playerUpdateSchema, the
 * isActive+groupId-scoped Generate lookup, the groupId-scoped delete).
 */

/** M7: a sport-scoped role key (allowed values come from the Group's SportDefinition). */
export type PlayerPosition = string;
export type PlayerRating = "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";

type PlayerLike = {
  id: string;
  firstName: string;
  lastName: string;
  position: PlayerPosition;
  rating: PlayerRating;
  stamina: number;
  isActive: boolean;
};

export const PLAYER_RATINGS: PlayerRating[] = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"];
/** Same 1–5 range as validation.ts staminaSchema; 3 is the server default. */
export const STAMINA_OPTIONS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_STAMINA = 3;

// ---------------------------------------------------------------
// Player form (shared by Create and Edit)
// ---------------------------------------------------------------

export type PlayerFormValues = {
  firstName: string;
  lastName: string;
  position: PlayerPosition;
  rating: PlayerRating;
  stamina: number;
  isActive: boolean;
};

/** `defaultRole` comes from the Group's sport (newPlayerRoleKey; soccer keeps Midfielder). */
export function emptyPlayerForm(defaultRole: PlayerPosition = "MIDFIELDER"): PlayerFormValues {
  return {
    firstName: "",
    lastName: "",
    position: defaultRole,
    rating: "GOOD",
    stamina: DEFAULT_STAMINA,
    isActive: true,
  };
}

export function playerFormFromPlayer(p: PlayerLike): PlayerFormValues {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position,
    rating: p.rating,
    stamina: Number.isFinite(Number(p.stamina)) ? Number(p.stamina) : DEFAULT_STAMINA,
    isActive: p.isActive,
  };
}

/** Client-side pre-check; returns an error message or null. */
export function validatePlayerForm(v: PlayerFormValues, roleKeys: readonly string[], roleNoun = "position"): string | null {
  if (!v.firstName.trim() || !v.lastName.trim()) return "First name and last name are required.";
  if (!roleKeys.includes(v.position)) return `Choose a valid ${roleNoun.toLowerCase()}.`;
  if (!PLAYER_RATINGS.includes(v.rating)) return "Choose a valid rating.";
  if (!(STAMINA_OPTIONS as readonly number[]).includes(v.stamina)) return "Stamina must be between 1 and 5.";
  return null;
}

/**
 * Request body for both canonical POST /players and PATCH /players/[id].
 * Exactly the six Player fields — never groupId/organizationId (the
 * server stamps/scopes by the URL-resolved Group).
 */
export function playerFormToBody(v: PlayerFormValues) {
  return {
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    position: v.position,
    rating: v.rating,
    stamina: v.stamina,
    isActive: v.isActive,
  };
}

// ---------------------------------------------------------------
// Shared player selection (checkboxes + Telegram import + Generate)
// ---------------------------------------------------------------

export type Selection = Record<string, boolean>;

/**
 * Keeps only ids of players that still exist AND are active. Canonical
 * Generate rejects the whole request if any selected id is inactive or
 * missing, so a deleted/deactivated player must drop out of the
 * selection instead of silently breaking the next Generate.
 */
export function pruneSelection(selected: Selection, players: Pick<PlayerLike, "id" | "isActive">[]): Selection {
  const selectable = new Set(players.filter((p) => p.isActive).map((p) => p.id));
  const next: Selection = {};
  for (const [id, on] of Object.entries(selected)) {
    if (on && selectable.has(id)) next[id] = true;
  }
  return next;
}

export function activePlayerIds(players: Pick<PlayerLike, "id" | "isActive">[]): string[] {
  return players.filter((p) => p.isActive).map((p) => p.id);
}

/** "All" header checkbox: checks or unchecks every ACTIVE player only (legacy semantics). */
export function applySelectAllActive(
  selected: Selection,
  players: Pick<PlayerLike, "id" | "isActive">[],
  checked: boolean
): Selection {
  const next: Selection = { ...selected };
  for (const id of activePlayerIds(players)) {
    if (checked) next[id] = true;
    else delete next[id];
  }
  return next;
}

export function selectAllActiveState(
  selected: Selection,
  players: Pick<PlayerLike, "id" | "isActive">[]
): "none" | "some" | "all" {
  const active = activePlayerIds(players);
  if (active.length === 0) return "none";
  const count = active.filter((id) => selected[id]).length;
  if (count === 0) return "none";
  return count === active.length ? "all" : "some";
}

/**
 * M7 — sport-aware pre-generation role check over the selected, active
 * players (replaces the soccer-only goalkeeper count). Only the sport's
 * non-IGNORE role rules are checked, so basketball/volleyball never see a
 * goalkeeper line. For soccer this is the legacy rule exactly: warn when
 * fewer goalkeepers than teams are selected. Advisory only.
 */
export function selectedRoleCoverage(
  sport: SportRules,
  players: Pick<PlayerLike, "id" | "isActive" | "position">[],
  selectedIds: string[],
  teamCount: number
): RoleCoverage[] {
  const sel = new Set(selectedIds);
  return rosterRoleCoverage(sport, players.filter((p) => sel.has(p.id) && p.isActive), teamCount);
}

/** UI line for a short role, labels from the sport ("Goalkeepers: 2 available for 3 teams"). */
export function roleCoverageMessage(
  sport: Pick<SportRules, "roles">,
  c: Pick<RoleCoverage, "roleKey" | "available" | "needed" | "perTeam" | "warn">,
  teamCount: number
): string {
  const plural = sport.roles.find((r) => r.key === c.roleKey)?.pluralLabel ?? c.roleKey;
  if (!c.warn) return `${plural}: ${c.available} across ${teamCount} teams`;
  return c.perTeam === 1
    ? `${plural}: ${c.available} available for ${teamCount} teams`
    : `${plural}: ${c.available} available, ${c.needed} needed for ${teamCount} teams`;
}

// ---------------------------------------------------------------
// Telegram import → Generate date
// ---------------------------------------------------------------

/**
 * Generate date to apply after a successful poll import: the poll's
 * persisted TelegramPoll.pollDate (YYYY-MM-DD) only. Null when the
 * column is null — never derived from question text, never guessed.
 */
export function generateDateFromImportedPoll(
  poll: { persistedPollDate: string | null } | null | undefined
): string | null {
  const d = poll?.persistedPollDate ?? null;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// ---------------------------------------------------------------
// Delete Published Teams
// ---------------------------------------------------------------

export function isYmd(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** Canonical DELETE path suffix for adminTenantApiPath (the date is the only input). */
export function deletePublishedPath(date: string): string {
  return `/publish?date=${encodeURIComponent(date)}`;
}

/**
 * After deleting a date's published teams, the current publishedGeneration
 * is gone if it was for that date (so Close/Post is no longer offered for
 * it); otherwise it is unaffected.
 */
export function publishedGenerationAfterDelete(
  current: PublishedGeneration | null,
  deletedDate: string
): PublishedGeneration | null {
  if (current && current.date === deletedDate) return null;
  return current;
}
