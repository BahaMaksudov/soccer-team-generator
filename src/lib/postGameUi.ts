/**
 * M9-D — pure client-state rules of the organizer post-game panel (kept out
 * of React so they are unit-testable).
 */

export const AI_DRAFT_READY_MESSAGE = "AI draft ready — review and save. Nothing was published or sent.";
export const AI_DRAFT_REGENERATED_MESSAGE = "New AI draft ready — review and save. Nothing was published or sent.";

/** "Generate AI Recap" until an AI draft was produced in the current editing session, then "Regenerate AI Recap". */
export function aiButtonLabel(aiDraftGenerated: boolean): "Generate AI Recap" | "Regenerate AI Recap" {
  return aiDraftGenerated ? "Regenerate AI Recap" : "Generate AI Recap";
}

/**
 * Replacing the textarea (AI draft or standard recap) needs a confirmation only
 * when it holds the organizer's own unsaved edits: non-empty, not the value we
 * last put there (AI draft / standard recap / loaded saved recap) and not the
 * saved recap itself (which is safe in the database).
 */
export function needsReplaceConfirmation(current: string, lastProgrammatic: string | null, savedServer: string | null | undefined): boolean {
  if (current.trim().length === 0) return false;
  if (lastProgrammatic !== null && current === lastProgrammatic) return false;
  if (typeof savedServer === "string" && current === savedServer) return false;
  return true;
}

/**
 * "Generate AI Recap" response → what the panel shows. Success ONLY when the
 * server returned a non-empty draft: the draft goes into the textarea and the
 * success message appears together. Anything else is a failure message (the
 * standard recap stays available).
 */
export function aiDraftOutcome(res: { ok: boolean; data: unknown }, regenerate = false): { kind: "draft"; text: string; message: string } | { kind: "failed"; message: string } {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as { text?: unknown; error?: unknown };
  if (res.ok && typeof data.text === "string" && data.text.trim().length > 0) {
    return { kind: "draft", text: data.text, message: regenerate ? AI_DRAFT_REGENERATED_MESSAGE : AI_DRAFT_READY_MESSAGE };
  }
  return { kind: "failed", message: typeof data.error === "string" && data.error ? data.error : "The AI recap failed. Use the standard recap." };
}

/**
 * The client "Generate AI Recap" handler (used by PostGameSection). Review
 * only: one POST, no view reload. On success the draft and the success
 * message are applied together; otherwise only the failure message.
 */
export async function generateRecapDraft(deps: {
  request: (body: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;
  setDraft: (text: string) => void;
  notify: (message: string | null) => void;
  setError: (message: string | null) => void;
  /** true when an AI draft was already generated in this editing session (message wording only). */
  regenerate?: boolean;
}): Promise<"draft" | "failed"> {
  deps.setError(null);
  deps.notify(null);
  let outcome: ReturnType<typeof aiDraftOutcome>;
  try {
    outcome = aiDraftOutcome(await deps.request({ action: "generate_recap" }), deps.regenerate === true);
  } catch {
    outcome = { kind: "failed", message: "The AI recap failed. Use the standard recap." };
  }
  if (outcome.kind === "draft") {
    deps.setDraft(outcome.text);
    deps.notify(outcome.message);
    return "draft";
  }
  deps.setError(outcome.message);
  return "failed";
}

/**
 * Textarea sync with the SERVER's saved recap: only a newly saved, non-empty
 * server value replaces what the organizer sees. A server value that is (or
 * becomes) empty — e.g. the recap row appearing with no saved content after
 * an AI draft was generated — never clears an unsaved local draft.
 */
export function syncedRecapText(current: string, previousServer: string | null | undefined, nextServer: string | null | undefined): string {
  if (typeof nextServer === "string" && nextServer.length > 0 && nextServer !== previousServer) return nextServer;
  return current;
}

export type MvpMethod = "PLAYER_VOTE" | "ORGANIZER_SELECTION";
export type MvpStage =
  | "RESULT_NOT_PUBLISHED"
  | "WAITING_FOR_MANAGER"
  | "CHOOSE_METHOD"
  // Player Vote (Telegram poll among published participants)
  | "NEEDS_TELEGRAM_GROUP"
  | "READY_TO_START"
  | "OPEN"
  | "CLOSED"
  // Organizer Selection (OWNER/ADMIN picks a published participant)
  | "SELECT_PLAYER"
  | "SELECTION_SAVED"
  | "PUBLISHED";

type MvpView = {
  result: { published: boolean } | null;
  mvp: { started: boolean; open: boolean; closed: boolean; published: boolean; method?: MvpMethod | null; voteLocked?: boolean; selection?: { playerId: string } | null } | null;
  messages: { destinationConnected: boolean } | null;
};

/**
 * Player-of-the-Match card state. The server's method wins once it is locked
 * (a vote started, or an organizer selection saved); before that the
 * organizer's in-page choice (`chosen`) decides. No free-text MVP exists.
 */
export function mvpStage(pg: MvpView, canManage: boolean, chosen: MvpMethod | null = null): MvpStage {
  if (!pg.result?.published) return "RESULT_NOT_PUBLISHED";
  const mvp = pg.mvp;
  if (mvp?.published) return "PUBLISHED";
  const serverMethod: MvpMethod | null = mvp?.voteLocked || mvp?.open || mvp?.closed ? "PLAYER_VOTE" : mvp?.method === "ORGANIZER_SELECTION" && mvp.selection ? "ORGANIZER_SELECTION" : null;
  if (serverMethod === "PLAYER_VOTE") {
    if (mvp?.closed) return "CLOSED";
    if (mvp?.open) return "OPEN";
    if (!canManage || !pg.messages) return "WAITING_FOR_MANAGER";
    return pg.messages.destinationConnected ? "READY_TO_START" : "NEEDS_TELEGRAM_GROUP"; // e.g. retry an uncertain poll
  }
  if (serverMethod === "ORGANIZER_SELECTION") return canManage ? "SELECTION_SAVED" : "WAITING_FOR_MANAGER";
  if (!canManage || !pg.messages) return "WAITING_FOR_MANAGER";
  if (chosen === "ORGANIZER_SELECTION") return "SELECT_PLAYER";
  if (chosen === "PLAYER_VOTE") return pg.messages.destinationConnected ? "READY_TO_START" : "NEEDS_TELEGRAM_GROUP";
  return "CHOOSE_METHOD";
}

/** Whether the organizer may still switch between the two methods in the page. */
export function mvpMethodSwitchable(pg: MvpView): boolean {
  return Boolean(pg.result?.published) && !pg.mvp?.published && !pg.mvp?.voteLocked && !pg.mvp?.open && !pg.mvp?.closed && !(pg.mvp?.method === "ORGANIZER_SELECTION" && pg.mvp.selection);
}

/** DOM id of the Match's Telegram-group selector (Attendance section), for "Choose Telegram group". */
export const MATCH_TELEGRAM_GROUP_SELECTOR_ID = "match-telegram-group";

/** A score field's normalized value: a non-negative integer (≤ 999), or null when empty/invalid. */
export function normalizeScore(raw: string | undefined): number | null {
  const t = (raw ?? "").trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  return Number(t);
}

/**
 * Result editor dirty state. No saved result → "Save Result". A saved result
 * whose fields still equal it (compared as numbers, so "05" == 5) → no action
 * ("Saved"). Any difference → "Save Changes". The server stays authoritative
 * for validation.
 */
export function resultEditorState(
  teamNumbers: number[],
  saved: Array<{ teamNumber: number; score: number }> | null,
  local: Record<number, string | undefined>
): { action: "SAVE_RESULT" | "SAVE_CHANGES" | null; valid: boolean; dirty: boolean } {
  const values = teamNumbers.map((n) => normalizeScore(local[n]));
  const valid = values.every((v) => v !== null);
  if (!saved) return { action: "SAVE_RESULT", valid, dirty: values.some((v) => v !== null) };
  const savedBy = new Map(saved.map((s) => [s.teamNumber, s.score]));
  const dirty = teamNumbers.some((n, i) => values[i] !== savedBy.get(n));
  return { action: dirty ? "SAVE_CHANGES" : null, valid, dirty };
}

// M9-D — Match Summary readiness lives in a neutral module shared by the UI and the server.
export { summaryReadiness, type ReadinessItem, type SummaryReadiness } from "@/lib/matchSummaryReadiness";
