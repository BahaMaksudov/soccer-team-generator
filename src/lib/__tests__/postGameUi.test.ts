import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AI_DRAFT_READY_MESSAGE, aiDraftOutcome, generateRecapDraft, mvpStage, syncedRecapText } from "@/lib/postGameUi";

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

describe("Player of the Match card stages", () => {
  const base = { result: { published: true }, mvp: null, messages: { destinationConnected: true } };
  it("A–F, plus the MEMBER and missing-Telegram-group states (never a blank card)", () => {
    expect(mvpStage({ ...base, result: null }, true)).toBe("RESULT_NOT_PUBLISHED");
    expect(mvpStage({ ...base, result: { published: false } }, true)).toBe("RESULT_NOT_PUBLISHED");
    expect(mvpStage({ ...base, messages: { destinationConnected: false } }, true)).toBe("NEEDS_TELEGRAM_GROUP");
    expect(mvpStage({ ...base, messages: null }, false)).toBe("WAITING_FOR_MANAGER");
    expect(mvpStage(base, true)).toBe("READY_TO_START");
    expect(mvpStage({ ...base, mvp: { started: false, open: false, closed: false, published: false } }, true)).toBe("READY_TO_START"); // e.g. poll send uncertain
    expect(mvpStage({ ...base, mvp: { started: true, open: true, closed: false, published: false } }, true)).toBe("OPEN");
    expect(mvpStage({ ...base, mvp: { started: true, open: true, closed: false, published: false }, messages: null }, false)).toBe("OPEN");
    expect(mvpStage({ ...base, mvp: { started: true, open: false, closed: true, published: false }, messages: { destinationConnected: false } }, true)).toBe("CLOSED");
    expect(mvpStage({ ...base, mvp: { started: true, open: false, closed: true, published: true } }, true)).toBe("PUBLISHED");
  });
});

describe("PostGameSection wiring", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection.tsx"), "utf8");
  it("Generate uses the review-only handler (no reload/act) and the textarea is bound to the draft state", () => {
    expect(src).toContain("await generateRecapDraft({ request, setDraft: setRecapText, notify, setError: setAiMessage });");
    expect(src).not.toMatch(/act\(\{ action: "generate_recap"/);
    expect(src).toContain("value={recapText}");
    expect(src).toContain("syncedRecapText(current, lastServerRecap.current, next)");
    expect(src).not.toMatch(/setRecapText\(pg\.recap\?\.content \?\? ""\)/);
  });
  it("every MVP stage renders an explanation or action; no free-text MVP field exists", () => {
    for (const stage of ["RESULT_NOT_PUBLISHED", "NEEDS_TELEGRAM_GROUP", "WAITING_FOR_MANAGER", "READY_TO_START", "OPEN", "CLOSED", "PUBLISHED"]) {
      expect(src, stage).toContain(`"${stage}"`);
    }
    expect(src).toContain("Publish the result before starting Player of the Match voting.");
    expect(src).toContain("Select a connected Telegram group for this match to start Player of the Match voting.");
    expect(src).toContain("Choose Telegram group");
    expect(src).toContain("Start Player of the Match Vote");
    expect(src).toContain("Close Vote");
    expect(src).not.toMatch(/mvpName|mvp_name|playerName.*input/i);
  });
});
