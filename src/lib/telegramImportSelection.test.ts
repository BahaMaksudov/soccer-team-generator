import { describe, it, expect } from "vitest";
import { applyImportedPlayerSelection } from "./telegramImportSelection";

/**
 * Phase 2D.6D.5C §12 — proves the "imported ids -> existing
 * selected-player state" contract used by
 * CanonicalAdminWorkspace.applyImportedSelection(), which is the
 * exact function CanonicalTelegramSection's onImportedPlayerIds prop
 * calls after a successful import. This is a state-transition test,
 * not a route test — the route tests (telegram/import/route.test.ts)
 * only prove the API response shape; this proves what happens to the
 * SAME selection state Generate reads once that response reaches the
 * canonical workspace.
 */
describe("applyImportedPlayerSelection", () => {
  it("marks every imported player id as selected", () => {
    const result = applyImportedPlayerSelection(["p1", "p2", "p3"]);
    expect(result).toEqual({ p1: true, p2: true, p3: true });
  });

  it("an empty import result clears the selection", () => {
    const result = applyImportedPlayerSelection([]);
    expect(result).toEqual({});
  });

  it("REPLACES rather than merges with whatever was selected before — matching legacy AdminWorkspace semantics", () => {
    // Simulates the checkbox for "p9" already being checked before the
    // import runs (e.g., the admin had manually ticked a player).
    const previousSelection: Record<string, boolean> = { p9: true };

    const nextSelection = applyImportedPlayerSelection(["p1"]);

    // The function itself never reads previousSelection at all — this
    // is what "replace, not merge" means in practice: whatever
    // CanonicalAdminWorkspace.setSelected(...) receives here
    // completely discards the prior map.
    expect(nextSelection).not.toHaveProperty("p9");
    expect(nextSelection).toEqual({ p1: true });
    expect(Object.keys(nextSelection).length).toBe(1);
  });

  it("the resulting selectedIds count (as CanonicalGenerateSection displays it) equals the imported id count", () => {
    const imported = ["p1", "p2", "p3", "p4"];
    const result = applyImportedPlayerSelection(imported);

    // Mirrors CanonicalAdminWorkspace's own selectedIds derivation:
    // Object.entries(selected).filter(([, v]) => v).map(([id]) => id)
    const selectedIds = Object.entries(result)
      .filter(([, v]) => v)
      .map(([id]) => id);

    expect(selectedIds.length).toBe(imported.length);
    expect(new Set(selectedIds)).toEqual(new Set(imported));
  });

  it("duplicate imported ids collapse to a single selected entry", () => {
    const result = applyImportedPlayerSelection(["p1", "p1", "p2"]);
    expect(Object.keys(result).length).toBe(2);
    expect(result).toEqual({ p1: true, p2: true });
  });
});
