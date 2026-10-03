import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AI_DRAFT_READY_MESSAGE, AI_DRAFT_REGENERATED_MESSAGE, aiButtonLabel, aiDraftOutcome, generateRecapDraft, mvpMethodSwitchable, mvpStage, needsReplaceConfirmation, syncedRecapText } from "@/lib/postGameUi";

/**
 * M9-D production-validation fix: "AI draft ready" appeared but the recap
 * textarea stayed blank. Root cause: generating creates the MatchRecap row
 * (generatedContent only), so after the view reload the saved content went
 * undefined → null, and the textarea sync effect (`setRecapText(content ?? "")`)
 * wiped the freshly generated draft.
 */

/** Minimal model of PostGameSection's textarea state + its server-sync effect. */
function panel(initialServer: string | null | undefined) {
  let text = initialServer ?? "";
  let lastServer = initialServer;
  const messages: Array<string | null> = [];
  const errors: Array<string | null> = [];
  return {
    get text() {
      return text;
    },
    messages,
    errors,
    setDraft: (t: string) => {
      text = t;
    },
    notify: (m: string | null) => messages.push(m),
    setError: (m: string | null) => errors.push(m),
    /** a view reload delivers a new pg.recap?.content → the effect runs */
    serverReload(next: string | null | undefined) {
      text = syncedRecapText(text, lastServer, next);
      lastServer = next;
    },
    type: (t: string) => {
      text = t;
    },
  };
}

const DRAFT = "What a night! Team 1 won 5–3. Thanks for playing ⚽";

describe("Generate AI Recap → textarea (exact production bug)", () => {
  it("first generation on a Match without a recap row: draft stays in the textarea after the view reload (undefined → null)", async () => {
    const p = panel(undefined); // no MatchRecap row yet
    const request = vi.fn(async () => ({ ok: true, data: { ok: true, text: DRAFT } }));
    expect(await generateRecapDraft({ request, setDraft: p.setDraft, notify: p.notify, setError: p.setError })).toBe("draft");
    expect(request).toHaveBeenCalledWith({ action: "generate_recap" });
    expect(p.text).toBe(DRAFT);
    expect(p.messages.at(-1)).toBe(AI_DRAFT_READY_MESSAGE);
    // The row now exists with content = null — the old effect set "" here.
    p.serverReload(null);
    expect(p.text).toBe(DRAFT);
    const oldEffect = (next: string | null | undefined) => next ?? "";
    expect(oldEffect(null)).toBe(""); // documents the pre-fix behavior
  });

  it("the success message never appears without a non-empty draft", async () => {
    for (const data of [{ ok: true, text: "" }, { ok: true, text: "   " }, { ok: true }, null]) {
      const p = panel(undefined);
      expect(await generateRecapDraft({ request: async () => ({ ok: true, data }), setDraft: p.setDraft, notify: p.notify, setError: p.setError })).toBe("failed");
      expect(p.messages).not.toContain(AI_DRAFT_READY_MESSAGE);
      expect(p.text).toBe("");
      expect(p.errors.at(-1)).toMatch(/standard recap/);
    }
  });

  it("provider failure (503 + fallback) or a network error keeps the textarea and shows the error", async () => {
    const p = panel("Saved recap.");
    p.type("My unsaved edits");
    await generateRecapDraft({
      request: async () => ({ ok: false, data: { error: "The AI took too long. Try again, or use the standard recap.", code: "TIMEOUT", fallback: "Team 1 beat Team 2, 5–3." } }),
      setDraft: p.setDraft,
      notify: p.notify,
      setError: p.setError,
    });
    expect(p.text).toBe("My unsaved edits");
    expect(p.errors.at(-1)).toBe("The AI took too long. Try again, or use the standard recap.");
    await generateRecapDraft({ request: async () => { throw new TypeError("fetch failed"); }, setDraft: p.setDraft, notify: p.notify, setError: p.setError });
    expect(p.text).toBe("My unsaved edits");
    expect(p.messages).not.toContain(AI_DRAFT_READY_MESSAGE);
  });

  it("a newly SAVED server recap replaces the textarea; an unchanged or empty one never does", () => {
    const p = panel(null);
    p.type(DRAFT);
    p.serverReload(null);
    expect(p.text).toBe(DRAFT);
    p.serverReload(DRAFT); // organizer saved it
    expect(p.text).toBe(DRAFT);
    p.type(`${DRAFT} edited`);
    p.serverReload(DRAFT); // unrelated reload, same saved value → keep edits
    expect(p.text).toBe(`${DRAFT} edited`);
    p.serverReload("Corrected elsewhere."); // a different saved value arrives
    expect(p.text).toBe("Corrected elsewhere.");
  });

  it("aiDraftOutcome: success needs ok + non-empty text", () => {
    expect(aiDraftOutcome({ ok: true, data: { text: DRAFT } })).toEqual({ kind: "draft", text: DRAFT, message: AI_DRAFT_READY_MESSAGE });
    expect(aiDraftOutcome({ ok: false, data: { text: DRAFT } }).kind).toBe("failed");
  });
});

describe("Player of the Match card stages (Player Vote / Organizer Selection)", () => {
  const base = { result: { published: true }, mvp: null, messages: { destinationConnected: true } };
  const vote = (o: object) => ({ ...base, mvp: { started: true, open: false, closed: false, published: false, method: "PLAYER_VOTE" as const, voteLocked: true, selection: null, ...o } });
  it("before a method is locked: choose method; each method has its own next step; never blank", () => {
    expect(mvpStage({ ...base, result: null }, true)).toBe("RESULT_NOT_PUBLISHED");
    expect(mvpStage({ ...base, result: { published: false } }, true, "ORGANIZER_SELECTION")).toBe("RESULT_NOT_PUBLISHED");
    expect(mvpStage(base, true)).toBe("CHOOSE_METHOD");
    expect(mvpStage(base, true, "PLAYER_VOTE")).toBe("READY_TO_START");
    expect(mvpStage({ ...base, messages: { destinationConnected: false } }, true, "PLAYER_VOTE")).toBe("NEEDS_TELEGRAM_GROUP");
    expect(mvpStage({ ...base, messages: { destinationConnected: false } }, true, "ORGANIZER_SELECTION")).toBe("SELECT_PLAYER"); // no Telegram needed
    expect(mvpStage({ ...base, messages: null }, false)).toBe("WAITING_FOR_MANAGER");
    expect(mvpMethodSwitchable(base)).toBe(true);
  });
  it("a started vote locks PLAYER_VOTE (the in-page choice cannot override it)", () => {
    expect(mvpStage(vote({ open: true }), true, "ORGANIZER_SELECTION")).toBe("OPEN");
    expect(mvpStage(vote({ started: false }), true, "ORGANIZER_SELECTION")).toBe("READY_TO_START"); // uncertain poll → retry only
    expect(mvpStage(vote({ closed: true }), true)).toBe("CLOSED");
    expect(mvpMethodSwitchable(vote({ open: true }))).toBe(false);
    expect(mvpStage(vote({ open: true }), false)).toBe("OPEN");
  });
  it("a saved organizer selection locks ORGANIZER_SELECTION until reset; published locks everything", () => {
    const saved = { ...base, mvp: { started: false, open: false, closed: false, published: false, method: "ORGANIZER_SELECTION" as const, voteLocked: false, selection: { playerId: "p1" } } };
    expect(mvpStage(saved, true, "PLAYER_VOTE")).toBe("SELECTION_SAVED");
    expect(mvpStage(saved, false)).toBe("WAITING_FOR_MANAGER");
    expect(mvpMethodSwitchable(saved)).toBe(false);
    const published = { ...saved, mvp: { ...saved.mvp, published: true } };
    expect(mvpStage(published, true, "PLAYER_VOTE")).toBe("PUBLISHED");
    expect(mvpMethodSwitchable(published)).toBe(false);
  });
});

describe("Generate → Regenerate AI Recap", () => {
  it("1/2/10: label is Generate until a draft succeeds, then Regenerate; an error does not flip it", async () => {
    let generated = false;
    const run = async (data: unknown, ok = true) => {
      const r = await generateRecapDraft({ request: async () => ({ ok, data }), setDraft: () => {}, notify: () => {}, setError: () => {}, regenerate: generated });
      if (r === "draft") generated = true;
    };
    expect(aiButtonLabel(generated)).toBe("Generate AI Recap");
    await run({ error: "The AI took too long." }, false);
    expect(aiButtonLabel(generated)).toBe("Generate AI Recap");
    await run({ text: "Draft one ⚽" });
    expect(aiButtonLabel(generated)).toBe("Regenerate AI Recap");
    await run({ text: "" });
    expect(aiButtonLabel(generated)).toBe("Regenerate AI Recap");
  });
  it("3/9: regeneration replaces the unsaved AI draft with the new one (new-draft message); empty/error leaves the textarea", async () => {
    const p = panel(undefined);
    await generateRecapDraft({ request: async () => ({ ok: true, data: { text: "Draft one ⚽" } }), setDraft: p.setDraft, notify: p.notify, setError: p.setError });
    expect(p.messages.at(-1)).toBe(AI_DRAFT_READY_MESSAGE);
    await generateRecapDraft({ request: async () => ({ ok: true, data: { text: "Draft two 🏆" } }), setDraft: p.setDraft, notify: p.notify, setError: p.setError, regenerate: true });
    expect(p.text).toBe("Draft two 🏆");
    expect(p.messages.at(-1)).toBe(AI_DRAFT_REGENERATED_MESSAGE);
    await generateRecapDraft({ request: async () => ({ ok: true, data: { text: "  " } }), setDraft: p.setDraft, notify: p.notify, setError: p.setError, regenerate: true });
    await generateRecapDraft({ request: async () => ({ ok: false, data: { error: "busy" } }), setDraft: p.setDraft, notify: p.notify, setError: p.setError, regenerate: true });
    expect(p.text).toBe("Draft two 🏆");
  });
  it("7/8: replacing asks first only for the organizer's own unsaved edits", () => {
    // untouched AI draft / standard recap / saved recap / empty → no confirmation
    expect(needsReplaceConfirmation("Draft one", "Draft one", null)).toBe(false);
    expect(needsReplaceConfirmation("Team 1 beat Team 2, 5–3.", "Team 1 beat Team 2, 5–3.", null)).toBe(false);
    expect(needsReplaceConfirmation("Saved text", "Draft one", "Saved text")).toBe(false);
    expect(needsReplaceConfirmation("   ", null, null)).toBe(false);
    // edited AI draft, edited standard recap, typed from scratch → confirmation
    expect(needsReplaceConfirmation("Draft one + my joke", "Draft one", null)).toBe(true);
    expect(needsReplaceConfirmation("Team 1 beat Team 2, 5–3. Legends.", "Team 1 beat Team 2, 5–3.", null)).toBe(true);
    expect(needsReplaceConfirmation("My own words", null, null)).toBe(true);
    expect(needsReplaceConfirmation("Saved text, edited", "Saved text", "Saved text")).toBe(true);
  });
});

describe("PostGameSection wiring", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection.tsx"), "utf8");
  it("Generate uses the review-only handler (no reload/act) and the textarea is bound to the draft state", () => {
    expect(src).toContain("const r = await generateRecapDraft({");
    expect(src).toContain("regenerate: aiGenerated,");
    expect(src).toContain("aiButtonLabel(aiGenerated)");
    expect(src).toContain("will replace your current unsaved recap. Continue?");
    expect(src).not.toMatch(/act\(\{ action: "generate_recap"/);
    expect(src).toContain("value={recapText}");
    expect(src).toContain("syncedRecapText(current, lastServerRecap.current, next)");
    expect(src).not.toMatch(/setRecapText\(pg\.recap\?\.content \?\? ""\)/);
  });
  it("every MVP stage renders an explanation or action; no free-text MVP field exists", () => {
    for (const stage of ["RESULT_NOT_PUBLISHED", "NEEDS_TELEGRAM_GROUP", "WAITING_FOR_MANAGER", "READY_TO_START", "OPEN", "CLOSED", "SELECT_PLAYER", "SELECTION_SAVED", "PUBLISHED"]) {
      expect(src, stage).toContain(`"${stage}"`);
    }
    expect(src).toContain("Publish the result before choosing Player of the Match.");
    expect(src).toContain("Select a connected Telegram group for this match to start Player of the Match voting");
    expect(src).toContain("Choose how Player of the Match will be decided:");
    expect(src).toContain("Organizer Selection");
    expect(src).toContain("Save Selection");
    expect(src).toContain('{p.name} — Team {p.teamNumber}');
    expect(src).toContain("Player of the Match selection saved — not published.");
    expect(src).toContain("Choose Telegram group");
    expect(src).toContain("Start Player of the Match Vote");
    expect(src).toContain("Close Vote");
    expect(src).not.toMatch(/mvpName|mvp_name|playerName.*input/i);
  });
});

// ------------------------------------------------------------------ Match Summary readiness
import { summaryReadiness } from "@/lib/postGameUi";

describe("Match Summary readiness", () => {
  const base = { result: { published: true }, mvp: { published: true }, recap: { content: "Saved recap.", published: false }, messages: { summary: "posted" } };
  it("1/2: a saved-but-unpublished recap is shown as excluded with a Publish Recap shortcut for OWNER/ADMIN", () => {
    const r = summaryReadiness(base, true);
    expect(r.items).toEqual([
      { key: "result", label: "Final result", included: true, note: null },
      { key: "mvp", label: "Player of the Match", included: true, note: null },
      { key: "recap", label: "Match recap", included: false, note: "saved, not published" },
    ]);
    expect(r.publishRecapShortcut).toBe(true);
  });
  it("3: MEMBER never gets the shortcut", () => {
    expect(summaryReadiness(base, false).publishRecapShortcut).toBe(false);
  });
  it("published recap → included, no shortcut; no recap → plain 'not published', no shortcut", () => {
    expect(summaryReadiness({ ...base, recap: { content: "x", published: true } }, true)).toMatchObject({ publishRecapShortcut: false });
    expect(summaryReadiness({ ...base, recap: { content: "x", published: true } }, true).items[2]).toMatchObject({ included: true, note: null });
    const none = summaryReadiness({ ...base, recap: null }, true);
    expect(none.items[2]).toEqual({ key: "recap", label: "Match recap", included: false, note: "not published" });
    expect(none.publishRecapShortcut).toBe(false);
  });
  it("MVP: published / organizer selection saved / vote closed / absent", () => {
    expect(summaryReadiness({ ...base, mvp: { published: false, method: "ORGANIZER_SELECTION", selection: { playerId: "p" } } }, true).items[1].note).toBe("selected, not published");
    expect(summaryReadiness({ ...base, mvp: { published: false, closed: true } }, true).items[1].note).toBe("vote closed, not published");
    expect(summaryReadiness({ ...base, mvp: null }, true).items[1]).toMatchObject({ included: false, note: "not published" });
  });
  it("'The published Match Summary has changed' only for updated_available", () => {
    expect(summaryReadiness({ ...base, messages: { summary: "updated_available" } }, true).summaryChanged).toBe(true);
    expect(summaryReadiness(base, true).summaryChanged).toBe(false);
  });
});
