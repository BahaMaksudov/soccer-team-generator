import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TeamsTelegramPost from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/TeamsTelegramPost";
import { recapEditorState } from "@/lib/postGameUi";
import { normalizeRecapText } from "@/lib/recapText";
import { sanitizeRecapText } from "@/lib/recap";
import type { TeamsDeliveryState } from "@/lib/closeAndPostUi";

/**
 * M9.1 — (1) Match Workspace Telegram team-post recovery states,
 * (3) recap editor dirty state normalized exactly like the server.
 */
const W = "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]";
const workspace = fs.readFileSync(path.join(process.cwd(), `${W}/MatchWorkspace.tsx`), "utf8");
const component = fs.readFileSync(path.join(process.cwd(), `${W}/TeamsTelegramPost.tsx`), "utf8");

const render = (state: TeamsDeliveryState | null, deliveryId: string | null = "d1") =>
  renderToStaticMarkup(createElement(TeamsTelegramPost, { state, deliveryId, busy: false, onPost: () => {}, onMarkSent: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("1 — Telegram team-post states in the Match Workspace", () => {
  it("posted: confirmation only — no warning, no buttons", () => {
    const html = render("posted");
    expect(html).toContain("These published teams were posted to Telegram.");
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain('role="alert"');
  });
  it("not posted / updated teams: the unchanged post buttons", () => {
    expect(buttons(render("not_posted"))).toEqual(["Post Teams to Telegram"]);
    expect(buttons(render(null))).toEqual(["Post Teams to Telegram"]);
    expect(buttons(render("updated_available"))).toEqual(["Post Updated Teams to Telegram"]);
  });
  it("definite failure: says nothing was posted and offers Retry posting teams (no Mark as sent)", () => {
    const html = render("failed");
    expect(html).toContain("Telegram rejected the last attempt — nothing was posted.");
    expect(buttons(html)).toEqual(["Retry posting teams"]);
  });
  it("uncertain: explicit duplicate warning; Mark as sent + Retry posting teams; nothing auto-retries", () => {
    const html = render("uncertain");
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn&#x27;t confirm whether Telegram received the teams");
    expect(html).toContain("could post the teams twice");
    expect(buttons(html)).toEqual(["Mark as sent", "Retry posting teams"]);
    // Without a known delivery id, Mark as sent cannot target anything.
    expect(render("uncertain", null)).toMatch(/<button[^>]*disabled=""[^>]*>Mark as sent<\/button>/);
  });
  it("uncertain retry needs a second, explicit confirmation and targets that delivery (retry_uncertain + deliveryId)", () => {
    expect(component).toContain("setConfirmRetry(true)");
    expect(component).toContain('onPost("retry_uncertain", deliveryId ?? undefined)');
    expect(component).toContain("Post the teams again? This can duplicate the message.");
  });
  it("sending: no action while a post is in progress", () => {
    expect(buttons(render("sending"))).toEqual([]);
  });
  it("wiring: managers only; mark as sent goes to telegram/delivery (never a send endpoint); retry passes the deliveryId", () => {
    expect(workspace).toMatch(/\{view\.canManage &&\s*\(view\.telegram\.poll\?\.pollId \? \(\s*<TeamsTelegramPost /);
    expect(workspace).toContain('path: "/telegram/delivery" }), {\n        method: "POST"');
    expect(workspace).toContain('JSON.stringify({ action: "mark_sent", deliveryId })');
    expect(workspace).toContain("...(deliveryId ? { deliveryId } : {})");
    expect(workspace).toContain("setTeamsDeliveryId(data?.deliveryId ?? null)");
  });
});

describe("3 — recap editor dirty state (normalized exactly like the server)", () => {
  const saved = "Team 1 beat Team 2, 5–3. Great game!";
  it("A: unchanged saved/published text → Save disabled", () => {
    expect(recapEditorState(saved, saved)).toEqual({ dirty: false, canSave: false });
  });
  it("B: an edit → Save enabled", () => {
    expect(recapEditorState(`${saved} Rematch next week.`, saved)).toEqual({ dirty: true, canSave: true });
  });
  it("C: after a successful save the server value equals the field → Save disabled again", () => {
    const edited = `${saved} Rematch next week.`;
    expect(recapEditorState(edited, sanitizeRecapText(edited))).toEqual({ dirty: false, canSave: false });
  });
  it("whitespace-only / no-op edits are not changes (the server would store the same text)", () => {
    for (const noop of [`  ${saved}  `, saved.replace(" beat ", "   beat\t"), `${saved}\n\n\n`, saved.replace("Great", "<b>Great</b>")]) {
      expect(sanitizeRecapText(noop)).toBe(saved);
      expect(recapEditorState(noop, saved), JSON.stringify(noop)).toEqual({ dirty: false, canSave: false });
    }
  });
  it("one normalization for both sides: the editor and save_recap agree", () => {
    for (const raw of ["a  b", " x\t\ty ", "p\n\n\n\nq", "<i>hi</i>", "\u0007bell"]) expect(normalizeRecapText(raw)).toBe(sanitizeRecapText(raw) ?? "");
    expect(recapEditorState("   ", null)).toEqual({ dirty: false, canSave: false });
  });
});

// ------------------------------------------------------------ M9.1 D — saved vs published recap (panel states)
import { vi } from "vitest";
import PostGameSection, { type PostGameView } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection";
import { summaryReadiness } from "@/lib/matchSummaryReadiness";

describe("3D — recap panel: published / saved-not-published / saved changes not published", () => {
  const view = (recap: PostGameView["recap"]): PostGameView => ({
    canceled: false,
    teamNumbers: [1, 2],
    fixturePairs: [[1, 2]],
    participants: [{ playerId: "a", name: "A", teamNumber: 1 }, { playerId: "b", name: "B", teamNumber: 2 }],
    result: { fixtures: [{ teamA: 1, teamB: 2, scoreA: 1, scoreB: 0, winner: 1 }], legacyStandings: null, published: true, complete: true },
    mvp: null,
    mvpMaxCandidates: 10,
    recap,
    standardRecap: "Standard.",
    aiConfigured: false,
    messages: { destinationConnected: true, summary: "posted", mvpPoll: null },
  });
  const render = (recap: PostGameView["recap"], canManage = true) =>
    renderToStaticMarkup(createElement(PostGameSection, { pg: view(recap), canManage, busy: false, act: vi.fn(), request: vi.fn(), notify: vi.fn() }));
  const section = (out: string, id: string, next: string) => out.slice(out.indexOf(`id="${id}"`), next ? out.indexOf(`id="${next}"`) : undefined);
  const saveDisabled = /<button[^>]*disabled=""[^>]*>Save Recap<\/button>/;

  it("A/D: published and unchanged → Published; Save disabled; no publish button", () => {
    const r = section(render({ content: "Recap B", source: "MANUAL", published: true, changesUnpublished: false, hasAiDraft: false }), "recap", "summary");
    expect(r).toContain(">Published<");
    expect(r).toMatch(saveDisabled);
    expect(r).not.toMatch(/Publish (Recap|Changes)/);
    expect(r).not.toContain("changes not published");
  });
  it("C: published with newer saved changes → 'Saved — changes not published'; Save disabled; Publish Changes offered; players keep the published recap", () => {
    const out = render({ content: "Recap B", source: "MANUAL", published: true, changesUnpublished: true, hasAiDraft: false });
    const r = section(out, "recap", "summary");
    expect(r).toContain("Saved — changes not published");
    expect(r).toMatch(saveDisabled);
    expect(r).toContain(">Publish Changes</button>");
    expect(r).toContain("Players keep seeing the published recap until you publish your saved changes.");
    expect(section(out, "summary", "")).toContain("The Match Summary uses the published recap until you publish them.");
  });
  it("never published: Save → 'Saved, not published' and Publish Recap — never 'changes not published'", () => {
    const r = section(render({ content: "Draft A", source: "MANUAL", published: false, changesUnpublished: false, hasAiDraft: false }), "recap", "summary");
    expect(r).toContain("Saved, not published");
    expect(r).toContain(">Publish Recap</button>");
    expect(r).not.toContain("changes not published");
    expect(r).toMatch(saveDisabled);
  });
  it("MEMBER read-only view renders only what the server gives it (the published copy); no editor or publish", () => {
    const r = section(render({ content: "Recap A", source: null, published: true, changesUnpublished: false, hasAiDraft: false }, false), "recap", "");
    expect(r).toContain("Recap A");
    expect(r).toContain(">Published<");
    expect(r).not.toMatch(/<textarea|Save Recap|<button[^>]*>[^<]*Publish/);
  });
  it("Match Summary readiness: the published recap is included; pending changes are named, never sent", () => {
    const base = { result: { published: true }, mvp: null, messages: { summary: "posted" } };
    const pending = summaryReadiness({ ...base, recap: { content: "Recap B", published: true, changesUnpublished: true } }, true);
    expect(pending.items.find((i) => i.key === "recap")).toEqual({ key: "recap", label: "Match recap", included: true, note: "published version; newer saved changes not published" });
    expect(pending.publishRecapShortcut).toBe(true);
    const clean = summaryReadiness({ ...base, recap: { content: "Recap B", published: true, changesUnpublished: false } }, true);
    expect(clean.items.find((i) => i.key === "recap")?.note).toBeNull();
    expect(clean.publishRecapShortcut).toBe(false);
    expect(summaryReadiness({ ...base, recap: { content: "Recap B", published: true, changesUnpublished: true } }, false).publishRecapShortcut).toBe(false);
  });
});
