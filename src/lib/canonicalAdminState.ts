import type { PublishedGeneration } from "@/lib/closeAndPostUi";

/**
 * Phase 2D.6D.5E.3 — pure, framework-free helpers for canonical Admin
 * Player/Generate state (this repo's vitest runs in node with no React
 * renderer — same approach as telegramImportSelection.ts and
 * closeAndPostUi.ts). UX only; every rule here is re-enforced
 * server-side (playerCreateSchema/playerUpdateSchema, the
 * isActive+groupId-scoped Generate lookup, the groupId-scoped delete).
 */

export type PlayerPosition = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
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

export const PLAYER_POSITIONS: PlayerPosition[] = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];
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

export function emptyPlayerForm(): PlayerFormValues {
  return {
    firstName: "",
    lastName: "",
    position: "MIDFIELDER",
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
export function validatePlayerForm(v: PlayerFormValues): string | null {
  if (!v.firstName.trim() || !v.lastName.trim()) return "First name and last name are required.";
  if (!PLAYER_POSITIONS.includes(v.position)) return "Choose a valid position.";
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

/** Same count legacy GenerationControls used: selected, active goalkeepers. */
export function countSelectedGoalkeepers(
  players: Pick<PlayerLike, "id" | "isActive" | "position">[],
  selectedIds: string[]
): number {
  const sel = new Set(selectedIds);
  return players.filter((p) => sel.has(p.id) && p.isActive && p.position === "GOALKEEPER").length;
}

/** Legacy warning rule, unchanged: fewer selected goalkeepers than teams. Advisory only. */
export function shouldWarnGoalkeepers(selectedGoalkeepers: number, teamCount: number): boolean {
  return selectedGoalkeepers < teamCount;
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
