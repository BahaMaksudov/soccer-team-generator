import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6D.5E.3 — source-level wiring for canonical Player/Delete
 * parity (node-only vitest, no React renderer).
 */

const root = path.resolve(__dirname, "../../..");
const dir = path.join(root, "src/app/admin/o/[organizationSlug]/g/[groupSlug]");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const players = stripComments(read("CanonicalPlayersSection.tsx"));
const form = stripComments(read("CanonicalPlayerForm.tsx"));
const generate = stripComments(read("CanonicalGenerateSection.tsx"));
const workspace = stripComments(read("CanonicalAdminWorkspace.tsx"));
const telegram = stripComments(read("CanonicalTelegramSection.tsx"));

function fn(src: string, start: string, end: string) {
  return src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start) + 1));
}

describe("canonical Player create/edit", () => {
  it("create POSTs the full form body to the canonical /players route", () => {
    const create = fn(players, "async function createPlayer", "async function saveEdit");
    expect(players).toContain('adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" })');
    expect(create).toContain("fetch(playersUrl");
    expect(create).toContain('method: "POST"');
    expect(create).toContain("JSON.stringify(playerFormToBody(values))");
  });

  it("edit PATCHes the full form body to canonical /players/[id]", () => {
    const edit = fn(players, "async function saveEdit", "async function toggleActive");
    expect(players).toContain("adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${id}` })");
    expect(edit).toContain("fetch(playerUrl(editing.id)");
    expect(edit).toContain('method: "PATCH"');
    expect(edit).toContain("JSON.stringify(playerFormToBody(values))");
  });

  it("the shared form exposes all six fields", () => {
    for (const label of ["First Name", "Last Name", "Position", "Rating", "Stamina", "Active"]) {
      expect(form).toContain(label);
    }
    for (const key of ['"firstName"', '"lastName"', '"position"', '"rating"', '"stamina"', '"isActive"']) {
      expect(form).toContain(`set(${key}`);
    }
  });

  it("both Create and Edit use CanonicalPlayerForm", () => {
    expect(players.match(/<CanonicalPlayerForm/g)).toHaveLength(2);
    expect(players).toContain("initial={emptyPlayerForm()}");
    expect(players).toContain("initial={playerFormFromPlayer(editing)}");
  });

  it("player delete requires an inline confirmation step", () => {
    expect(players).toContain("onClick={() => setConfirmDeleteId(p.id)}");
    expect(players).toMatch(/confirmDeleteId === p\.id \?[\s\S]*onClick=\{\(\) => removePlayer\(p\)\}/);
  });

  it("Players section never owns a second selection state", () => {
    expect(players).not.toMatch(/useState<Record<string, boolean>>/);
    expect(players).toContain("onSelectAllActive(e.target.checked)");
  });
});

describe("shared selection + import date (workspace)", () => {
  it("every player refresh prunes the one shared selection", () => {
    const load = fn(workspace, "async function loadPlayers", "useEffect(");
    expect(load).toContain("setSelected((prev) => pruneSelection(prev, list))");
  });

  it("Telegram import replaces then prunes the same selection and applies the poll date", () => {
    const imp = fn(workspace, "function applyImportedPoll", "const selectedIds");
    expect(imp).toContain("pruneSelection(applyImportedPlayerSelection(ids), players)");
    expect(imp).toContain("setSelected(next)");
    expect(imp).toContain("if (pollDate) setGenerateDate(pollDate)");
    expect(workspace.match(/useState<Record<string, boolean>>/g)).toHaveLength(1);
  });

  it("Telegram section derives the Generate date only from persistedPollDate", () => {
    const imp = fn(telegram, "async function importPoll", "const [closePostPollId");
    expect(imp.length).toBeGreaterThan(0);
    expect(imp).not.toContain("closePollAndPostTeams");
    expect(imp).toContain("onImportedPoll(ids, generateDateFromImportedPoll(importedPoll))");
    expect(imp).not.toMatch(/\.pollDate\b|pollDateStr|question/);
  });

  it("Generate date is owned by the workspace, not the Generate section", () => {
    expect(workspace).toContain("date={generateDate}");
    expect(generate).not.toMatch(/const \[date, setDate\]/);
    expect(generate).toContain("onChange={(e) => onDateChange(e.target.value)}");
  });
});

describe("canonical Delete Published Teams", () => {
  const del = fn(generate, "async function deletePublishedTeams", "\n  return (");

  it("uses the canonical DELETE /publish?date=… route", () => {
    expect(del).toContain(
      "fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: deletePublishedPath(deleteDate) })"
    );
    expect(del).toContain('method: "DELETE"');
  });

  it("only the Confirm button (shown after an explicit first click) performs the delete", () => {
    expect(generate).toMatch(/confirmingDelete \?[\s\S]*onClick=\{deletePublishedTeams\}[\s\S]*: \([\s\S]*setConfirmingDelete\(true\)/);
    expect(generate.match(/onClick=\{deletePublishedTeams\}/g)).toHaveLength(1);
    expect(generate).toContain("Delete published teams for <b>{deleteDate}</b>?");
  });

  it("clears publishedGeneration for the deleted date on success", () => {
    expect(del).toContain("onPublishedGenerationChange(publishedGenerationAfterDelete(publishedGeneration, deleteDate))");
  });

  it("makes no Telegram call and does not claim to remove Telegram messages", () => {
    expect(del).not.toMatch(/\/telegram\/|close-and-post|callTelegram/i);
    expect(generate).toContain("does not delete or edit any");
  });

  it("the Published badge is derived from publishedGeneration (cleared by delete)", () => {
    expect(generate).toContain("const published = publishedGeneration !== null;");
    expect(generate).not.toContain("setPublished(");
  });
});

describe("goalkeeper warning", () => {
  it("Generate shows the legacy warning via shouldWarnGoalkeepers", () => {
    expect(workspace).toContain("countSelectedGoalkeepers(players, selectedIds)");
    expect(generate).toContain("shouldWarnGoalkeepers(selectedGoalkeeperCount, teamCount)");
  });
});

describe("canonical tree has zero flat operational Admin API calls", () => {
  it("no /api/admin/ string outside adminTenantApiPath in any canonical file", () => {
    for (const f of fs.readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n) && !n.endsWith(".test.ts"))) {
      expect(stripComments(read(f)), f).not.toMatch(/["'`]\/api\//);
    }
  });
});
