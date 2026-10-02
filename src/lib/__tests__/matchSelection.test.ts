import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { defaultSelection, effectiveAttendance, type AttendanceRow } from "@/lib/attendance";
import { computeSelection, NO_ADJUSTMENTS, reconcileAdjustments, toggleSelection, type EffectiveStatuses, type SelectionAdjustments } from "@/lib/matchSelection";

/**
 * Regression for the M9-A manual-smoke bug: Teams selection was copied from
 * the attendance default only on first mount, so players later made PLAYING
 * (e.g. by organizer override) stayed unselected. This harness mirrors the
 * Match workspace exactly: every "refresh" recomputes the default from real
 * attendance rows (defaultSelection → effectiveAttendance), reconciles the
 * organizer's adjustments, and derives the selection.
 */

type Status = "PLAYING" | "NOT_PLAYING" | "MAYBE";
const PLAYERS = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, isActive: true }));

function workspace() {
  const rows = new Map<string, AttendanceRow>();
  let adj: SelectionAdjustments = NO_ADJUSTMENTS;
  let last: EffectiveStatuses | null = null;
  let defaults: string[] = [];
  const row = (id: string) => rows.get(id) ?? { playerId: id, participantStatus: null, participantSource: null, participantRespondedAt: null, overrideStatus: null, overrideAt: null };
  const refresh = () => {
    const list = [...rows.values()];
    defaults = defaultSelection(PLAYERS, list, null);
    const statuses = Object.fromEntries(PLAYERS.map((p) => [p.id, effectiveAttendance(rows.get(p.id), null).status]));
    adj = reconcileAdjustments(last, statuses, adj);
    last = statuses;
  };
  const api = {
    participant(id: string, status: Status | null, source: "TELEGRAM" | "WEB" = "TELEGRAM") {
      rows.set(id, { ...row(id), participantStatus: status, participantSource: source, participantRespondedAt: new Date() });
      refresh();
    },
    override(id: string, status: Status | null) {
      rows.set(id, { ...row(id), overrideStatus: status, overrideAt: status ? new Date() : null });
      refresh();
    },
    toggle(id: string) {
      adj = toggleSelection(defaults, adj, id);
    },
    rerender() {
      // a React re-render re-derives from unchanged state; nothing is reset or forced
    },
    refreshUnchanged: refresh,
    selected: () => computeSelection(defaults, adj).sort(),
  };
  refresh();
  return api;
}

describe("Match Teams selection follows effective attendance", () => {
  it("1–4: initial PLAYING selected; MAYBE, NOT_PLAYING and no response not selected", () => {
    const w = workspace();
    w.participant("a", "PLAYING");
    w.participant("b", "MAYBE");
    w.participant("c", "NOT_PLAYING");
    expect(w.selected()).toEqual(["a"]); // d/e/f: no response
  });

  it("5: organizer No Response → PLAYING selects the player", () => {
    const w = workspace();
    w.override("d", "PLAYING");
    expect(w.selected()).toEqual(["d"]);
  });

  it("6–7: organizer PLAYING → MAYBE / NOT_PLAYING removes the attendance-derived selection", () => {
    const w = workspace();
    w.override("a", "PLAYING");
    w.override("b", "PLAYING");
    w.override("a", "MAYBE");
    w.override("b", "NOT_PLAYING");
    expect(w.selected()).toEqual([]);
  });

  it("8–9: clearing an override reveals the player's own answer (PLAYING → selected, MAYBE → not)", () => {
    const w = workspace();
    w.participant("a", "PLAYING");
    w.participant("b", "MAYBE");
    w.override("a", "NOT_PLAYING");
    w.override("b", "PLAYING");
    expect(w.selected()).toEqual(["b"]);
    w.override("a", null);
    w.override("b", null);
    expect(w.selected()).toEqual(["a"]);
  });

  it("10: a Telegram (or web) PLAYING answer selects the player after refresh", () => {
    const w = workspace();
    w.participant("e", "PLAYING", "TELEGRAM");
    w.participant("f", "PLAYING", "WEB");
    expect(w.selected()).toEqual(["e", "f"]);
  });

  it("11: production scenario — 2 initial + 8 later PLAYING (by override) are ALL selected", () => {
    const players = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, isActive: true }));
    let adj: SelectionAdjustments = NO_ADJUSTMENTS;
    let last: EffectiveStatuses | null = null;
    const rows: AttendanceRow[] = [];
    const set = (id: string, over: Partial<AttendanceRow>) => {
      const i = rows.findIndex((r) => r.playerId === id);
      const base: AttendanceRow = i >= 0 ? rows[i] : { playerId: id, participantStatus: null, participantSource: null, participantRespondedAt: null, overrideStatus: null, overrideAt: null };
      if (i >= 0) rows[i] = { ...base, ...over };
      else rows.push({ ...base, ...over });
    };
    const refresh = () => {
      const statuses = Object.fromEntries(players.map((p) => [p.id, effectiveAttendance(rows.find((r) => r.playerId === p.id), null).status]));
      adj = reconcileAdjustments(last, statuses, adj);
      last = statuses;
      return computeSelection(defaultSelection(players, rows, null), adj);
    };
    set("p0", { overrideStatus: "PLAYING" });
    set("p1", { participantStatus: "PLAYING", participantSource: "TELEGRAM" });
    set("p2", { participantStatus: "NOT_PLAYING", participantSource: "TELEGRAM" });
    expect(refresh()).toHaveLength(2);
    for (let i = 3; i <= 10; i++) {
      set(`p${i}`, { overrideStatus: "PLAYING" });
      refresh(); // each mutation is followed by a refresh, as in the workspace
    }
    expect(refresh().sort()).toEqual(["p0", "p1", "p10", "p3", "p4", "p5", "p6", "p7", "p8", "p9"].sort());
  });

  it("12–14: manual adjustments work and survive re-renders/unchanged refreshes", () => {
    const w = workspace();
    w.participant("a", "PLAYING");
    w.participant("b", "MAYBE");
    w.toggle("b"); // include a MAYBE
    w.toggle("a"); // exclude a PLAYING
    expect(w.selected()).toEqual(["b"]);
    w.rerender();
    w.refreshUnchanged(); // a refresh with no attendance change keeps them
    expect(w.selected()).toEqual(["b"]);
    w.override("c", "PLAYING"); // another player's change doesn't disturb them either
    expect(w.selected()).toEqual(["b", "c"]);
    w.toggle("b");
    w.toggle("a"); // and they can be undone
    expect(w.selected()).toEqual(["a", "c"]);
  });

  it("a manual adjustment yields to a later change of THAT player's effective attendance", () => {
    const w = workspace();
    w.participant("b", "MAYBE");
    w.toggle("b"); // organizer includes the Maybe
    w.participant("b", "NOT_PLAYING"); // then the player says no
    expect(w.selected()).toEqual([]);
    w.participant("a", "PLAYING");
    w.toggle("a"); // exclude
    w.override("a", "MAYBE");
    w.override("a", "PLAYING"); // becomes PLAYING again → default applies
    expect(w.selected()).toEqual(["a"]);
  });
});

describe("Match workspace wiring", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx"), "utf8");
  it("derives selection on every refresh (no one-time copy of the default)", () => {
    expect(src).toContain("computeSelection(defaultIds, adjustments)");
    expect(src).toContain("reconcileAdjustments(lastStatuses.current, statuses, adj)");
    expect(src).toContain("toggleSelection(defaultIds, adj, p.id)");
    expect(src).not.toMatch(/resetSelection|setSelected\(/);
  });
});
