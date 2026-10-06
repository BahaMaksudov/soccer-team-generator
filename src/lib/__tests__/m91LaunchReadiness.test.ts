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
