/**
 * M9-A — Generate-from-Match player selection.
 *
 * The selection is DERIVED, not copied once: it is the attendance-derived
 * default (players whose effective attendance is PLAYING — computed
 * server-side by src/lib/attendance.ts) plus the organizer's explicit
 * checkbox adjustments:
 *
 *   selected = (default ∪ added) \ removed
 *
 * so every refreshed attendance (organizer override, cleared override,
 * Telegram vote, web answer, explicit sync) is reflected immediately, while
 * an organizer's manual include/exclude survives re-renders.
 *
 * When a player's EFFECTIVE status changes, any manual adjustment for that
 * player is dropped, so the new attendance decides (e.g. a manually included
 * MAYBE who then says NOT_PLAYING is no longer selected). Nothing else ever
 * resets an adjustment.
 */

export type SelectionAdjustments = { added: string[]; removed: string[] };
export type EffectiveStatuses = Record<string, string | null>;

export const NO_ADJUSTMENTS: SelectionAdjustments = { added: [], removed: [] };

export function computeSelection(defaultIds: readonly string[], adj: SelectionAdjustments): string[] {
  const removed = new Set(adj.removed);
  const out = defaultIds.filter((id) => !removed.has(id));
  for (const id of adj.added) if (!removed.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** The organizer ticks/unticks one player. Adjustments only record differences from the default. */
export function toggleSelection(defaultIds: readonly string[], adj: SelectionAdjustments, id: string): SelectionAdjustments {
  const isDefault = defaultIds.includes(id);
  const selected = computeSelection(defaultIds, adj).includes(id);
  const added = adj.added.filter((x) => x !== id);
  const removed = adj.removed.filter((x) => x !== id);
  if (selected) return isDefault ? { added, removed: [...removed, id] } : { added, removed };
  return isDefault ? { added, removed } : { added: [...added, id], removed };
}

/** After refreshed attendance: drop adjustments of players whose effective status changed (or who left the roster). */
export function reconcileAdjustments(prev: EffectiveStatuses | null, next: EffectiveStatuses, adj: SelectionAdjustments): SelectionAdjustments {
  if (!prev) return adj;
  const keep = (id: string) => id in next && (prev[id] ?? null) === (next[id] ?? null);
  const added = adj.added.filter(keep);
  const removed = adj.removed.filter(keep);
  return added.length === adj.added.length && removed.length === adj.removed.length ? adj : { added, removed };
}
