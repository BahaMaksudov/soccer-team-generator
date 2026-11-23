import { describe, it, expect } from "vitest";
import { applyPlacements, reconcileReuse } from "@/lib/reuseTeams";
import { cycleState, drawFromPool, normalizeSpotlightNote, SPOTLIGHT_NOTE_MAX } from "@/lib/spotlight";
import { formatTeamsHtml } from "@/lib/telegramFormat";
import { renderTelegramHtml } from "@/lib/messaging/telegram";
import { teamsContent } from "@/lib/messaging/content";
import { assignShirtColors } from "@/lib/shirtColors";

const p = (id: string, firstName = id.toUpperCase(), lastName = "P") => ({ id, firstName, lastName });
const source = [
  { teamNumber: 1, shirtColor: "purple", players: [p("a"), p("b"), p("c")] },
  { teamNumber: 2, shirtColor: "white", players: [p("d"), p("e"), p("f")] },
];

describe("Reuse previous teams — reconciliation by stable player id", () => {
  it("exact same attendance: every player keeps their team, in order; nothing absent or new", () => {
    const r = reconcileReuse(source, ["a", "b", "c", "d", "e", "f"]);
    expect(r.teams).toEqual([
      { teamNumber: 1, shirtColor: "purple", playerIds: ["a", "b", "c"] },
      { teamNumber: 2, shirtColor: "white", playerIds: ["d", "e", "f"] },
    ]);
    expect(r.absent).toEqual([]);
    expect(r.unassignedIds).toEqual([]);
  });
  it("some absent: left out (never re-added), listed with their old team", () => {
    const r = reconcileReuse(source, ["a", "c", "d", "e", "f"]);
    expect(r.teams[0].playerIds).toEqual(["a", "c"]);
    expect(r.absent).toEqual([{ id: "b", name: "B P", teamNumber: 1 }]);
    expect(r.unassignedIds).toEqual([]);
  });
  it("some new: listed as unassigned, never silently dropped", () => {
    const r = reconcileReuse(source, ["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(r.unassignedIds).toEqual(["g", "h"]);
    expect(r.teams.flatMap((t) => t.playerIds)).not.toContain("g");
  });
  it("both absent and new at once", () => {
    const r = reconcileReuse(source, ["a", "d", "x"]);
    expect(r.teams.map((t) => t.playerIds)).toEqual([["a"], ["d"]]);
    expect(r.absent.map((x) => x.id)).toEqual(["b", "c", "e", "f"]);
    expect(r.unassignedIds).toEqual(["x"]);
  });
  it("duplicate NAMES with different ids are different people — matched by id only", () => {
    const twins = [
      { teamNumber: 1, players: [p("id-1", "Alex", "Kim")] },
      { teamNumber: 2, players: [p("id-2", "Alex", "Kim")] },
    ];
    const r = reconcileReuse(twins, ["id-2", "id-3"]);
    expect(r.teams.map((t) => t.playerIds)).toEqual([[], ["id-2"]]);
    expect(r.absent).toEqual([{ id: "id-1", name: "Alex Kim", teamNumber: 1 }]);
    expect(r.unassignedIds).toEqual(["id-3"]); // a third "Alex Kim"-like newcomer is never merged by name
  });
  it("a malformed snapshot listing the same id twice never puts one player on two teams", () => {
    const bad = [
      { teamNumber: 1, players: [p("a")] },
      { teamNumber: 2, players: [p("a"), p("b")] },
    ];
    const r = reconcileReuse(bad, ["a", "b"]);
    expect(r.teams.flatMap((t) => t.playerIds).sort()).toEqual(["a", "b"]);
  });
  it("older publications without colors: none carried over (defaults are applied later by assignShirtColors)", () => {
    const r = reconcileReuse([{ teamNumber: 1, players: [p("a")] }, { teamNumber: 2, players: [p("b")] }], ["a", "b"]);
    expect(r.teams.map((t) => t.shirtColor)).toEqual([null, null]);
    expect(assignShirtColors(r.teams, r.teams).map((t) => t.shirtColor)).toEqual(["yellow", "blue"]);
  });
});

describe("Reuse — organizer placements", () => {
  const teams = [
    { teamNumber: 1, shirtColor: "purple" as const, playerIds: ["a"] },
    { teamNumber: 2, shirtColor: "white" as const, playerIds: ["d"] },
  ];
  it("every new player placed exactly once onto an existing team", () => {
    expect(applyPlacements(teams, ["g", "h"], { g: 2, h: 1 })).toEqual({
      ok: true,
      teams: [
        { teamNumber: 1, shirtColor: "purple", playerIds: ["a", "h"] },
        { teamNumber: 2, shirtColor: "white", playerIds: ["d", "g"] },
      ],
    });
  });
  it("refuses: a missing placement, an unknown team, a non-new player, or a team left empty", () => {
    expect(applyPlacements(teams, ["g", "h"], { g: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/Place every confirmed player/) });
    expect(applyPlacements(teams, ["g"], { g: 3 })).toMatchObject({ ok: false });
    expect(applyPlacements(teams, ["g"], { g: "1" })).toMatchObject({ ok: false });
    expect(applyPlacements(teams, ["g"], { g: 1, a: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/new to these teams/) });
    expect(applyPlacements([{ teamNumber: 1, shirtColor: null, playerIds: ["a"] }, { teamNumber: 2, shirtColor: null, playerIds: [] }], ["g"], { g: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/Team #2 would have no players/) });
  });
});

describe("Spotlight — fair draw and cycle rules (pure)", () => {
  it("the draw is uniform over the (sorted, de-duplicated) pool and uses the supplied secure source", () => {
    expect(drawFromPool([], () => 0)).toBeNull();
    expect(drawFromPool(["c", "a", "b", "a"], (max) => max - 1)).toBe("c");
    expect(drawFromPool(["c", "a", "b"], () => 0)).toBe("a");
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 3000; i++) counts[drawFromPool(["a", "b", "c"])!]++; // real crypto.randomInt
    for (const k of ["a", "b", "c"]) expect(counts[k]).toBeGreaterThan(800);
  });
  it("a cycle is complete only when every ACTIVE member has had a turn", () => {
    expect(cycleState(["a", "b", "c"], new Set(["a", "b"]))).toEqual({ roster: 3, selected: 2, complete: false });
    expect(cycleState(["a", "b", "c"], new Set(["a", "b", "c"]))).toEqual({ roster: 3, selected: 3, complete: true });
    expect(cycleState(["a", "b"], new Set(["a", "b", "z"]))).toEqual({ roster: 2, selected: 2, complete: true }); // z deactivated: doesn't block
    expect(cycleState(["a", "b", "new"], new Set(["a", "b"]))).toMatchObject({ complete: false }); // a new member joins the cycle
    expect(cycleState([], new Set())).toMatchObject({ complete: false });
  });
});

describe("Spotlight — organizer text", () => {
  it("plain text, trimmed, one line; emoji and Unicode kept; blank → none", () => {
    expect(normalizeSpotlightNote("  Bring the match ball! ⚽  ")).toEqual({ ok: true, note: "Bring the match ball! ⚽" });
    expect(normalizeSpotlightNote("Line one\nline two\ttab")).toEqual({ ok: true, note: "Line one line two tab" });
    expect(normalizeSpotlightNote("Привет — ¡vamos! 你好")).toEqual({ ok: true, note: "Привет — ¡vamos! 你好" });
    expect(normalizeSpotlightNote("   ")).toEqual({ ok: true, note: null });
    expect(normalizeSpotlightNote(null)).toEqual({ ok: true, note: null });
    expect(normalizeSpotlightNote("a‮evil​x")).toEqual({ ok: true, note: "aevilx" }); // bidi / zero-width controls dropped
  });
  it("length is counted in characters (emoji = 1) and capped; non-strings refused", () => {
    expect(normalizeSpotlightNote("⚽".repeat(SPOTLIGHT_NOTE_MAX))).toMatchObject({ ok: true });
    expect(normalizeSpotlightNote("x".repeat(SPOTLIGHT_NOTE_MAX + 1))).toMatchObject({ ok: false });
    expect(normalizeSpotlightNote({ html: "<b>" })).toMatchObject({ ok: false });
  });
});

describe("Telegram — Spotlight section", () => {
  const teams = [{ teamNumber: 1, shirtColor: "yellow", players: [{ firstName: "Ann", lastName: "A" }] }];
  it("appended at the very bottom: title, Selected: NAME, then the organizer text", () => {
    const html = renderTelegramHtml(
      teamsContent({ type: "TEAMS_PUBLISHED", displayDate: "11/23/26", teams, viewUrl: "https://teambalancepro.com/g/o/g/m/1", websiteUrl: "https://teambalancepro.com", location: { name: "Field", address: null, mapsUrl: null }, spotlight: { name: "Dee P", note: "Bring the match ball!" } })
    );
    expect(html.endsWith("\n\n<b>\u{1F3B2} Random Player Spotlight</b>\nSelected: Dee P\nBring the match ball!")).toBe(true);
    expect(html.indexOf("🎲")).toBeGreaterThan(html.indexOf("TeamBalance Pro</a>")); // after the links
    expect(html).toContain("<b>\u{1F7E1} Team #1 — YELLOW SHIRTS</b>\n• Ann A"); // existing content intact
    expect(html).toContain("Please wear your assigned team color");
  });
  it("name and text are HTML-escaped — no markup or script injection", () => {
    const html = formatTeamsHtml("1/1/27", teams, { name: "<b>Eve</b>", note: '<a href="javascript:alert(1)">x</a> & <script>' });
    expect(html).toContain("Selected: &lt;b&gt;Eve&lt;/b&gt;");
    // Text nodes need only & < > escaped (Telegram HTML); quotes are inert outside a tag.
    expect(html).toContain('&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt; &amp; &lt;script&gt;');
    expect(html).not.toMatch(/<script>|<a href="javascript/);
  });
  it("no text → just the name; no Spotlight → the message is byte-identical to before", () => {
    expect(formatTeamsHtml("1/1/27", teams, { name: "Dee P", note: null }).endsWith("<b>\u{1F3B2} Random Player Spotlight</b>\nSelected: Dee P")).toBe(true);
    expect(formatTeamsHtml("1/1/27", teams, null)).toBe(formatTeamsHtml("1/1/27", teams));
    expect(formatTeamsHtml("1/1/27", teams)).not.toContain("Spotlight");
  });
});
