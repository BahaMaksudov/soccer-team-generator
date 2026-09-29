/**
 * Phase 2D.6D.5C — pure state-transition helper: computes the new
 * `selected` player-id map after a successful Telegram poll import.
 * Extracted as a standalone pure function (rather than left inlined
 * inside CanonicalAdminWorkspace) specifically so the "imported ids ->
 * selected-player state" contract — which drives both the Players
 * section's checkboxes and CanonicalGenerateSection's
 * "Selected: N" count — can be unit-tested without a full React/DOM
 * render (this repo's vitest environment is "node"; no
 * @testing-library/react is installed).
 *
 * Matches the legacy AdminWorkspace.importFromTelegramPoll() semantics
 * exactly: REPLACES the current selection, never merges with it.
 */
export function applyImportedPlayerSelection(importedPlayerIds: string[]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const id of importedPlayerIds) next[id] = true;
  return next;
}
