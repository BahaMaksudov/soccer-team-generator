import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import {
  SHIRT_COLORS,
  SHIRT_COLOR_IDS,
  assignShirtColors,
  duplicateShirtColors,
  isShirtColorId,
  shirtColorLabel,
  teamsWithoutShirtColor,
} from "@/lib/shirtColors";
import { teamsContent } from "@/lib/messaging/content";
import { renderTelegramHtml } from "@/lib/messaging/telegram";
import { formatTeamsHtml, splitTelegramText } from "@/lib/telegramFormat";
import { toPlayerFacingTeams } from "@/lib/playerFacing";
import { assignmentKey, teamsPanelState } from "@/lib/teamAssignment";
import { buildPublishSnapshot } from "@/lib/publishTeams";
import { publishedTeamsOf } from "@/lib/matches";
import TeamPreview from "@/app/admin/components/TeamPreview";
import ShirtColorBadge from "@/components/teams/ShirtColorBadge";

const team = (n: number, ids: string[], extra: Record<string, unknown> = {}) => ({ teamNumber: n, players: ids.map((id) => ({ id, firstName: id.toUpperCase(), lastName: "P", position: "MIDFIELDER" as const })), ...extra });

describe("catalog: one source of truth", () => {
  it("the eight colors, in the default order, each with id, label, swatch and emoji", () => {
    expect(SHIRT_COLORS.map((c) => c.label)).toEqual(["Yellow", "Blue", "Orange", "White", "Black", "Red", "Green", "Purple"]);
    for (const c of SHIRT_COLORS) {
      expect(c.id).toMatch(/^[a-z]+$/);
      expect(c.swatch).toMatch(/^#[0-9A-F]{6}$/);
      expect(c.emoji.length).toBeGreaterThan(0);
    }
    expect(new Set(SHIRT_COLORS.map((c) => c.emoji)).size).toBe(8);
  });
  it("only catalog ids are valid — never CSS, hex, labels or other types", () => {
    for (const id of SHIRT_COLOR_IDS) expect(isShirtColorId(id)).toBe(true);
    for (const v of ["Yellow", "#FACC15", "rgb(0,0,0)", "pink", "", null, undefined, 1, {}]) expect(isShirtColorId(v), String(v)).toBe(false);
    expect(shirtColorLabel("blue")).toBe("Blue Shirts");
    expect(shirtColorLabel("teal")).toBeNull();
  });
});

describe("automatic assignment", () => {
  it("defaults by team number: Yellow, Blue, Orange, White, Black, Red, Green, Purple", () => {
    const teams = Array.from({ length: 8 }, (_, i) => team(i + 1, [`p${i}`]));
    expect(assignShirtColors(teams).map((t) => t.shirtColor)).toEqual(["yellow", "blue", "orange", "white", "black", "red", "green", "purple"]);
  });
  it("never changes players, order or team numbers (balancing is untouched)", () => {
    const teams = [team(2, ["c", "d"]), team(1, ["a", "b"])];
    const out = assignShirtColors(teams);
    expect(out.map(({ shirtColor: _c, ...rest }) => rest)).toEqual(teams);
    expect(out.map((t) => [t.teamNumber, t.shirtColor])).toEqual([[2, "blue"], [1, "yellow"]]);
  });
  it("regenerate keeps the owner's colors for the same team numbers; new teams get unused defaults", () => {
    const previous = [team(1, ["x"], { shirtColor: "purple" }), team(2, ["y"], { shirtColor: "yellow" })];
    const next = [team(1, ["a"]), team(2, ["b"]), team(3, ["c"])];
    expect(assignShirtColors(next, previous).map((t) => t.shirtColor)).toEqual(["purple", "yellow", "blue"]);
  });
  it("a clash in the carried-over colors is resolved, never duplicated", () => {
    const previous = [team(1, [], { shirtColor: "red" }), team(2, [], { shirtColor: "red" })];
    const out = assignShirtColors([team(1, ["a"]), team(2, ["b"])], previous);
    expect(out[0].shirtColor).toBe("red");
    expect(out[1].shirtColor).not.toBe("red");
    expect(duplicateShirtColors(out)).toEqual([]);
  });
  it("more than 8 teams: the extra teams get NO color (explicit), never a repeat", () => {
    const out = assignShirtColors(Array.from({ length: 10 }, (_, i) => team(i + 1, [`p${i}`])));
    expect(out.slice(8).map((t) => t.shirtColor)).toEqual([null, null]);
    expect(duplicateShirtColors(out)).toEqual([]);
    expect(teamsWithoutShirtColor(out)).toEqual([9, 10]);
  });
  it("duplicate detection ignores teams without a color", () => {
    expect(duplicateShirtColors([team(1, [], { shirtColor: "red" }), team(2, [], { shirtColor: "red" }), team(3, [], { shirtColor: null })])).toEqual(["red"]);
    expect(duplicateShirtColors([team(1, [], { shirtColor: null }), team(2, [], {})])).toEqual([]);
  });
});

describe("publish snapshot", () => {
  const owned = [
    { id: "a", firstName: "A", lastName: "P", position: "MIDFIELDER", rating: "GOOD", stamina: 3 },
    { id: "b", firstName: "B", lastName: "P", position: "DEFENDER", rating: "GOOD", stamina: 3 },
  ];
  it("stores the submitted colors; a payload without colors gets the defaults; players are the authoritative rows", () => {
    expect(buildPublishSnapshot([{ teamNumber: 1, shirtColor: "green", players: [{ id: "a" }] }, { teamNumber: 2, shirtColor: null, players: [{ id: "b" }] }], owned).map((t) => t.shirtColor)).toEqual(["green", null]);
    const defaults = buildPublishSnapshot([{ teamNumber: 1, players: [{ id: "a" }] }, { teamNumber: 2, players: [{ id: "b" }] }], owned);
    expect(defaults.map((t) => t.shirtColor)).toEqual(["yellow", "blue"]);
    expect(defaults[0].players[0]).toEqual(owned[0]);
  });
});

describe("Telegram teams message", () => {
  const teams = [
    { teamNumber: 1, shirtColor: "yellow", players: [{ firstName: "Ann", lastName: "A" }] },
    { teamNumber: 2, shirtColor: "blue", players: [{ firstName: "Bo", lastName: "B" }] },
    { teamNumber: 3, shirtColor: "orange", players: [{ firstName: "Cy", lastName: "C" }] },
  ];
  it("colored teams: emoji + 'Team #N — COLOR SHIRTS', players unchanged, then the pinnies reminder", () => {
    const html = formatTeamsHtml("11/9/26", teams);
    expect(html).toBe(
      [
        "<b>\u{1F3DF}\u{FE0F} Generated Teams — 11/9/26</b>",
        "",
        "<b>\u{1F7E1} Team #1 — YELLOW SHIRTS</b>",
        "• Ann A",
        "",
        "<b>\u{1F535} Team #2 — BLUE SHIRTS</b>",
        "• Bo B",
        "",
        "<b>\u{1F7E0} Team #3 — ORANGE SHIRTS</b>",
        "• Cy C",
        "",
        "Please wear your assigned team color or bring matching pinnies.",
      ].join("\n")
    );
  });
  it("every color has a readable name and its own emoji", () => {
    const all = formatTeamsHtml("x", SHIRT_COLORS.map((c, i) => ({ teamNumber: i + 1, shirtColor: c.id, players: [] })));
    for (const c of SHIRT_COLORS) expect(all).toContain(`${c.emoji} Team #`);
    for (const label of ["YELLOW", "BLUE", "ORANGE", "WHITE", "BLACK", "RED", "GREEN", "PURPLE"]) expect(all).toContain(`— ${label} SHIRTS`);
  });
  it("legacy teams without colors render byte-identically to before (no reminder) — the delivery hash is unchanged", () => {
    const legacy = teams.map(({ shirtColor: _c, ...t }) => t);
    expect(formatTeamsHtml("11/9/26", legacy)).toBe(["<b>\u{1F3DF}\u{FE0F} Generated Teams — 11/9/26</b>", "", "<b>Team #1</b>", "• Ann A", "", "<b>Team #2</b>", "• Bo B", "", "<b>Team #3</b>", "• Cy C"].join("\n"));
    expect(formatTeamsHtml("x", [{ teamNumber: 1, shirtColor: "not-a-color", players: [] }])).not.toContain("SHIRTS"); // unknown → treated as none
  });
  it("names are HTML-escaped; the reminder sits before the venue and links", () => {
    const html = renderTelegramHtml(
      teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "1/1/27", teams: [{ teamNumber: 1, shirtColor: "red", players: [{ firstName: "<b>Eve</b>", lastName: "&Co" }] }], viewUrl: "https://teambalancepro.com/g/o/g/m/1", websiteUrl: "https://teambalancepro.com", location: { name: "Park <1>", address: null, mapsUrl: null } })
    );
    expect(html).toContain("• &lt;b&gt;Eve&lt;/b&gt; &amp;Co");
    expect(html.indexOf("Please wear")).toBeGreaterThan(html.indexOf("&amp;Co"));
    expect(html.indexOf("Please wear")).toBeLessThan(html.indexOf("📍 Park &lt;1&gt;"));
    expect(html).toContain('<a href="https://teambalancepro.com/g/o/g/m/1">🔗 View teams online</a>');
  });
  it("a large colored roster still splits within Telegram's limit", () => {
    const big = SHIRT_COLORS.map((c, i) => ({ teamNumber: i + 1, shirtColor: c.id, players: Array.from({ length: 40 }, (_, j) => ({ firstName: `Player${j}`, lastName: "Longsurname" })) }));
    for (const part of splitTelegramText(formatTeamsHtml("1/1/27", big))) expect(part.length).toBeLessThanOrEqual(3900);
  });
});

describe("persistence readers", () => {
  it("player-facing teams carry a valid color only; legacy records keep their exact old shape", () => {
    const json = JSON.stringify([
      { teamNumber: 1, shirtColor: "green", players: [{ firstName: "A", lastName: "B", position: "DEFENDER", rating: "GOOD" }] },
      { teamNumber: 2, shirtColor: "javascript:alert(1)", players: [] },
      { teamNumber: 3, players: [] },
    ]);
    expect(toPlayerFacingTeams(json)).toEqual([
      { teamNumber: 1, shirtColor: "green", players: [{ firstName: "A", lastName: "B", position: "DEFENDER" }] },
      { teamNumber: 2, players: [] },
      { teamNumber: 3, players: [] },
    ]);
  });
  it("organizer workspace teams carry the saved color (survives refresh)", () => {
    expect(publishedTeamsOf(JSON.stringify([{ teamNumber: 1, shirtColor: "black", players: [{ id: "a", firstName: "A", lastName: "B", position: "X" }] }]))[0]).toMatchObject({ teamNumber: 1, shirtColor: "black" });
    expect(publishedTeamsOf(JSON.stringify([{ teamNumber: 1, players: [] }]))[0]).not.toHaveProperty("shirtColor");
  });
});

describe("preview vs published", () => {
  it("a color-only change makes the preview publishable; legacy teams key exactly as before", () => {
    const published = [team(1, ["a"], { shirtColor: "yellow" }), team(2, ["b"], { shirtColor: "blue" })];
    expect(teamsPanelState(published, published).canPublish).toBe(false);
    const recolored = [team(1, ["a"], { shirtColor: "red" }), team(2, ["b"], { shirtColor: "blue" })];
    expect(teamsPanelState(recolored, published)).toMatchObject({ mode: "published_with_new_preview", canPublish: true });
    expect(assignmentKey([team(1, ["b", "a"])])).toBe(JSON.stringify([[1, ["a", "b"]]]));
  });
});

describe("UI", () => {
  const teams = [team(1, ["a"], { shirtColor: "yellow" }), team(2, ["b"], { shirtColor: "blue" }), team(3, ["c"], { shirtColor: "orange" })];
  it("editable preview: swatch + 'Team #N — Color Shirts' + a labelled select; colors used by other teams are disabled", () => {
    const html = renderToStaticMarkup(createElement(TeamPreview, { previewTeams: teams, previewDate: "2026-11-09", sportKey: "soccer", onShirtColorChange: () => {} }));
    expect(html).toContain("Team #1<span class=\"font-semibold\"> — Yellow Shirts</span>");
    expect(html).toMatch(/<label for="shirt-color-preview-1"[^>]*>Shirt color<\/label><select id="shirt-color-preview-1" aria-label="Shirt color for Team #1"/);
    const select1 = /<select id="shirt-color-preview-1"[\s\S]*?<\/select>/.exec(html)![0];
    expect(select1).toMatch(/<option value="yellow" selected="">\u{1F7E1} Yellow<\/option>/u);
    expect(select1).toMatch(/<option value="blue" disabled="">\u{1F535} Blue \(Team #2\)<\/option>/u);
    expect(select1).toMatch(/<option value="purple">/);
    expect(html).toContain("h-10"); // 40px-tall control
    expect(html).toContain("text-base"); // 16px on phones (no iOS zoom), sm:text-sm on larger screens
    expect(html).toContain("flex-1"); // full-width select on narrow screens
  });
  it("published (read-only): color shown, no select", () => {
    const html = renderToStaticMarkup(createElement(TeamPreview, { previewTeams: teams, previewDate: "2026-11-09", sportKey: "soccer", variant: "published" }));
    expect(html).toContain("— Blue Shirts");
    expect(html).not.toContain("<select");
  });
  it("more than 8 teams: an explicit note names the teams without a color", () => {
    const many = assignShirtColors(Array.from({ length: 9 }, (_, i) => team(i + 1, [`p${i}`])));
    const html = renderToStaticMarkup(createElement(TeamPreview, { previewTeams: many, previewDate: "2026-11-09", sportKey: "soccer", onShirtColorChange: () => {} }));
    expect(html).toContain("There are 8 shirt colors, so Team #9 has no color.");
    expect(html).toMatch(/<select id="shirt-color-preview-9"[^>]*><option value="" selected="">No color<\/option>/);
  });
  it("legacy teams (no color): exactly the old header, no badge", () => {
    const html = renderToStaticMarkup(createElement(TeamPreview, { previewTeams: [team(1, ["a"])], previewDate: "2026-11-09", sportKey: "soccer", variant: "published" }));
    expect(html).toContain('<span class="font-display font-extrabold">Team #1</span>');
    expect(html).not.toContain("Shirts");
  });
  it("badge: swatch is decorative, the NAME carries the meaning (B/W print, color-blind); prints in color", () => {
    const html = renderToStaticMarkup(createElement(ShirtColorBadge, { color: "white" }));
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*border[^"]*print-color-adjust:exact[^"]*" style="background-color:#FFFFFF"><\/span>White Shirts/);
    expect(renderToStaticMarkup(createElement(ShirtColorBadge, { color: "#ff0000" }))).toBe("");
  });
  it("every player-facing team view and the print page render the badge", () => {
    for (const f of ["src/app/g/[organizationSlug]/[groupSlug]/page.tsx", "src/app/g/[organizationSlug]/[groupSlug]/print/[generationId]/page.tsx", "src/components/match-link/MatchView.tsx", "src/app/share/ShareView.tsx", "src/app/components/PlayerMatchCard.tsx"]) {
      expect(fs.readFileSync(f, "utf8"), f).toContain("<ShirtColorBadge color={t.shirtColor}");
    }
  });
  it("team generation itself is untouched: colors are attached only after balancing, in the preview and at publish", () => {
    const gen = fs.readFileSync("src/lib/balanceEngine.ts", "utf8");
    expect(gen).not.toMatch(/shirt/i);
  });
});
