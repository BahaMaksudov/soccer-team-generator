import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assignmentKey, sameAssignment, teamsPanelState, unpublishedPreviewOnScreen } from "@/lib/teamAssignment";
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
    expect(teamsPanelState(null, null)).toMatchObject({ mode: "none", generateLabel: "Generate", canPublish: false, canClearPreview: false });
    expect(teamsPanelState(A, null)).toMatchObject({ mode: "preview", generateLabel: "Regenerate", canPublish: true, canClearPreview: true });
    expect(teamsPanelState(A, A)).toMatchObject({ mode: "published", generateLabel: "Regenerate", canPublish: false, canClearPreview: true });
    expect(teamsPanelState(null, A)).toMatchObject({ mode: "published", generateLabel: "Regenerate", canPublish: false, canClearPreview: false });
  });
  it("published A + regenerated B → B publishable (A stays published); clearing B leaves A published", () => {
    expect(teamsPanelState(B, A)).toMatchObject({ mode: "published_with_new_preview", generateLabel: "Regenerate", canPublish: true, canClearPreview: true });
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

describe("UX refinement: one table at a time; Telegram only for the published teams", () => {
  const B = [{ teamNumber: 1, players: P("a", "c") }, { teamNumber: 2, players: P("b", "d") }];
  const D = "src/app/admin/o/[organizationSlug]/g/[groupSlug]/";
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), D + f), "utf8");
  const gen = read("CanonicalGenerateSection.tsx");
  const match = read("matches/[matchId]/MatchWorkspace.tsx");
  const tg = read("CanonicalTelegramSection.tsx");
  const ws = read("CanonicalAdminWorkspace.tsx");

  it("1: nothing published, no preview → Generate; no badge; no Telegram post", () => {
    const s = teamsPanelState(null, null);
    expect(s).toMatchObject({ mode: "none", generateLabel: "Generate", badge: null, showPublishedTable: false, canPostPublishedTeams: false });
  });
  it("2: preview, nothing published → preview table; no Telegram post", () => {
    const s = teamsPanelState(A, null);
    expect(s).toMatchObject({ mode: "preview", canPublish: true, badge: null, showPublishedTable: false, canPostPublishedTeams: false });
    expect(unpublishedPreviewOnScreen(s.mode)).toBe(true);
  });
  it("3: published, no preview → published table, Published badge, Telegram available", () => {
    const s = teamsPanelState(null, A);
    expect(s).toMatchObject({ mode: "published", badge: "Published", showPublishedTable: true, publishedVersionNote: false, canPostPublishedTeams: true });
  });
  it("4–8: published A + preview B → only B's table, 'Published version exists', note, no Telegram post", () => {
    const s = teamsPanelState(B, A);
    expect(s.mode).toBe("published_with_new_preview");
    expect(s.showPublishedTable).toBe(false); // 4: the old table is not rendered
    expect(s.publishedVersionNote).toBe(true); // 5–6
    expect(s.badge).toBe("Published version exists"); // 7: B is never labelled Published
    expect(s.canPostPublishedTeams).toBe(false); // 8
    expect(unpublishedPreviewOnScreen(s.mode)).toBe(true);
    expect(gen).toContain("✓ A published version already exists. Players still see the published teams until you click Publish;");
    expect(gen).toContain("panel.showPublishedTable ||");
  });
  it("9: Clear Preview returns to the Published A view (no request is made)", () => {
    expect(teamsPanelState(null, A)).toMatchObject({ mode: "published", showPublishedTable: true, canPostPublishedTeams: true });
    const clear = gen.slice(gen.indexOf("function clearPreview()"), gen.indexOf("async function applySuggestedSwap"));
    expect(clear).not.toContain("fetch(");
  });
  it("a preview identical to the published teams is shown as Published and may be posted", () => {
    const same = [{ teamNumber: 2, players: P("d", "c") }, { teamNumber: 1, players: P("b", "a") }];
    expect(teamsPanelState(same, A)).toMatchObject({ mode: "published", badge: "Published", canPostPublishedTeams: true });
  });
  it("16: Telegram team posting sends the published TeamGeneration id, never previewTeams", () => {
    expect(match).toContain("teamGenerationId: published.id");
    expect(match).not.toMatch(/previewTeams/);
    expect(tg).toContain("teamGenerationId: publishedGeneration.id");
    expect(tg).not.toMatch(/previewTeams/);
    // and both pages hide team posting while an unpublished preview is on screen
    expect(match).toContain("{published && !unpublishedPreviewOnScreen(panelMode) && (");
    expect(ws).toContain("previewPending={unpublishedPreviewOnScreen(panelMode)}");
    expect(tg).toContain("closePostEnabled && delivery && !previewPending");
  });
  it("16: the close-and-post request schema carries no team content", () => {
    const service = fs.readFileSync(path.join(process.cwd(), "src/lib/telegramCloseAndPost.ts"), "utf8");
    expect(service).toContain("persistedTeamsSchema.safeParse(JSON.parse(generation.teamsJson))");
    expect(service).toContain("const { pollId, teamGenerationId, intent, deliveryId, shareUrl } = parsed.data;");
  });
});
