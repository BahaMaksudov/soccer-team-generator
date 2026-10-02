import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assignmentKey, sameAssignment, teamsPanelState } from "@/lib/teamAssignment";
import TeamPreview from "@/app/admin/components/TeamPreview";

const P = (...ids: string[]) => ids.map((id) => ({ id, firstName: id.toUpperCase(), lastName: "X", position: "FORWARD" }));
const A = [{ teamNumber: 1, players: P("a", "b") }, { teamNumber: 2, players: P("c", "d") }];

describe("team assignment comparison (22–25)", () => {
  it("same teams with different player/team array order compare equal", () => {
    expect(sameAssignment(A, [{ teamNumber: 2, players: P("d", "c") }, { teamNumber: 1, players: P("b", "a") }])).toBe(true);
    expect(assignmentKey(A)).toBe(assignmentKey([{ teamNumber: 2, players: P("d", "c") }, { teamNumber: 1, players: P("b", "a") }]));
  });
  it("a player moving between teams, or a membership change, compares different", () => {
    expect(sameAssignment(A, [{ teamNumber: 1, players: P("a", "c") }, { teamNumber: 2, players: P("b", "d") }])).toBe(false);
    expect(sameAssignment(A, [{ teamNumber: 1, players: P("a", "b") }, { teamNumber: 2, players: P("c", "e") }])).toBe(false);
    expect(sameAssignment(A, [{ teamNumber: 1, players: P("a", "b") }, { teamNumber: 2, players: P("c") }])).toBe(false);
    expect(sameAssignment(A, null)).toBe(false);
  });
  it("stable for 3+ teams", () => {
    const three = [{ teamNumber: 3, players: P("e", "f") }, { teamNumber: 1, players: P("b", "a") }, { teamNumber: 2, players: P("d", "c") }];
    const again = [{ teamNumber: 1, players: P("a", "b") }, { teamNumber: 2, players: P("c", "d") }, { teamNumber: 3, players: P("f", "e") }];
    expect(assignmentKey(three)).toBe(assignmentKey(again));
    expect(sameAssignment(three, [{ teamNumber: 1, players: P("a", "b") }, { teamNumber: 2, players: P("c", "e") }, { teamNumber: 3, players: P("d", "f") }])).toBe(false);
  });
});

describe("Teams panel state (published vs preview)", () => {
  const B = [{ teamNumber: 1, players: P("a", "c") }, { teamNumber: 2, players: P("b", "d") }];
  it("nothing → Generate; preview only → publishable; published and identical → published, Regenerate", () => {
    expect(teamsPanelState(null, null)).toEqual({ mode: "none", generateLabel: "Generate", canPublish: false, canClearPreview: false });
    expect(teamsPanelState(A, null)).toEqual({ mode: "preview", generateLabel: "Regenerate", canPublish: true, canClearPreview: true });
    expect(teamsPanelState(A, A)).toEqual({ mode: "published", generateLabel: "Regenerate", canPublish: false, canClearPreview: true });
    expect(teamsPanelState(null, A)).toEqual({ mode: "published", generateLabel: "Regenerate", canPublish: false, canClearPreview: false });
  });
  it("published A + regenerated B → both, B publishable; clearing B leaves A published", () => {
    expect(teamsPanelState(B, A)).toEqual({ mode: "published_with_new_preview", generateLabel: "Regenerate", canPublish: true, canClearPreview: true });
    expect(teamsPanelState(null, A).mode).toBe("published");
  });
});

describe("TeamPreview labels never contradict the published state", () => {
  const html = (variant: "preview" | "new_preview" | "published") =>
    renderToStaticMarkup(createElement(TeamPreview, { variant, previewTeams: A, previewDate: "2026-10-05", sportKey: "soccer" }));
  it("published teams are labeled published; previews are labeled not published", () => {
    expect(html("published")).toContain("Published teams");
    expect(html("published")).not.toMatch(/not published/i);
    expect(html("preview")).toContain("Preview — not published");
    expect(html("new_preview")).toContain("New preview — not published");
    expect(html("new_preview")).toContain("Players still see the published teams");
    for (const v of ["preview", "new_preview", "published"] as const) expect(html(v)).not.toContain("Preview (not published yet)");
  });
});

describe("Generate section wiring: preview actions never touch the published state", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/CanonicalGenerateSection.tsx"), "utf8");
  const fn = (start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end));
  it("Generate/Regenerate, Clear Preview and Apply Swap do not reset the published generation or teams", () => {
    for (const body of [fn("async function generate()", "function clearPreview()"), fn("function clearPreview()", "async function applySuggestedSwap()"), fn("async function applySuggestedSwap()", "async function publish()")]) {
      expect(body).not.toMatch(/onPublishedGenerationChange|setPublishedTeams/);
    }
  });
  it("only Publish replaces the published teams; the panel mode comes from the actual assignments", () => {
    expect(fn("async function publish()", "// --- Delete Published Teams")).toContain("setPublishedTeams(previewTeams)");
    expect(src).toContain("teamsPanelState(previewTeams,");
  });
});
