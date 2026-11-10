/**
 * Team shirt / pinnies colors — the ONE catalog used by the preview UI, publish validation, the
 * stored snapshot (TeamGeneration.teamsJson → team.shirtColor), player-facing pages, print and
 * Telegram. Client-safe (no Node / Prisma imports).
 *
 * Only these ids are ever stored; arbitrary CSS colors are never accepted. A team's color never
 * influences who is on it (it is attached after balancing, by team number).
 *
 * Legacy snapshots have no shirtColor: they are shown and posted exactly as before (no color is
 * invented for games that never had one).
 */

export const SHIRT_COLORS = [
  { id: "yellow", label: "Yellow", swatch: "#FACC15", emoji: "\u{1F7E1}" },
  { id: "blue", label: "Blue", swatch: "#2563EB", emoji: "\u{1F535}" },
  { id: "orange", label: "Orange", swatch: "#F97316", emoji: "\u{1F7E0}" },
  { id: "white", label: "White", swatch: "#FFFFFF", emoji: "⚪" },
  { id: "black", label: "Black", swatch: "#111827", emoji: "⚫" },
  { id: "red", label: "Red", swatch: "#DC2626", emoji: "\u{1F534}" },
  { id: "green", label: "Green", swatch: "#16A34A", emoji: "\u{1F7E2}" },
  { id: "purple", label: "Purple", swatch: "#9333EA", emoji: "\u{1F7E3}" },
] as const;

export type ShirtColorId = (typeof SHIRT_COLORS)[number]["id"];
export type ShirtColor = (typeof SHIRT_COLORS)[number];
export const SHIRT_COLOR_IDS = SHIRT_COLORS.map((c) => c.id) as [ShirtColorId, ...ShirtColorId[]];
export const MAX_DISTINCT_SHIRT_COLORS = SHIRT_COLORS.length;
export const SHIRT_COLOR_REMINDER = "Please wear your assigned team color or bring matching pinnies.";

export function isShirtColorId(v: unknown): v is ShirtColorId {
  return typeof v === "string" && (SHIRT_COLOR_IDS as readonly string[]).includes(v);
}

export function shirtColorOf(id: unknown): ShirtColor | null {
  return SHIRT_COLORS.find((c) => c.id === id) ?? null;
}

/** "Yellow Shirts" (UI) — null when the team has no color. */
export function shirtColorLabel(id: unknown): string | null {
  const c = shirtColorOf(id);
  return c ? `${c.label} Shirts` : null;
}

type ColorableTeam = { teamNumber: number; shirtColor?: unknown };

/**
 * Attach shirt colors to (re)generated teams WITHOUT touching their players.
 *   1. a color the owner already chose for the same team number is kept (previous preview /
 *      published teams), unless another team already took it;
 *   2. every other team gets the first unused color in the default order
 *      (Yellow, Blue, Orange, White, Black, Red, Green, Purple);
 *   3. with more teams than colors, the extra teams get null (explicitly "no color") — never a
 *      repeated color that would make two teams look the same.
 */
export function assignShirtColors<T extends ColorableTeam>(teams: readonly T[], previous?: readonly ColorableTeam[] | null): Array<T & { shirtColor: ShirtColorId | null }> {
  const kept = new Map<number, ShirtColorId>();
  for (const p of previous ?? []) if (isShirtColorId(p.shirtColor)) kept.set(p.teamNumber, p.shirtColor);
  const used = new Set<ShirtColorId>();
  const order = [...teams].map((t, i) => ({ t, i })).sort((a, b) => a.t.teamNumber - b.t.teamNumber);
  const chosen = new Map<number, ShirtColorId | null>();
  // Pass 1: keep the owner's earlier choices (first team number wins on a clash).
  for (const { t, i } of order) {
    const c = kept.get(t.teamNumber);
    if (c && !used.has(c)) {
      chosen.set(i, c);
      used.add(c);
    }
  }
  // Pass 2: defaults for the rest.
  for (const { i } of order) {
    if (chosen.has(i)) continue;
    const next = SHIRT_COLOR_IDS.find((c) => !used.has(c)) ?? null;
    if (next) used.add(next);
    chosen.set(i, next);
  }
  return teams.map((t, i) => ({ ...t, shirtColor: chosen.get(i) ?? null }));
}

/** Color ids used by more than one team (nulls never clash). */
export function duplicateShirtColors(teams: readonly ColorableTeam[]): ShirtColorId[] {
  const seen = new Map<ShirtColorId, number>();
  for (const t of teams) if (isShirtColorId(t.shirtColor)) seen.set(t.shirtColor, (seen.get(t.shirtColor) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([c]) => c);
}

/** The teams that have no color (only possible with more teams than colors, or legacy data). */
export function teamsWithoutShirtColor(teams: readonly ColorableTeam[]): number[] {
  return teams.filter((t) => !isShirtColorId(t.shirtColor)).map((t) => t.teamNumber);
}
