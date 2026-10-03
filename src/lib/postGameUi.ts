/**
 * M9-D — pure client-state rules of the organizer post-game panel (kept out
 * of React so they are unit-testable).
 */

export const AI_DRAFT_READY_MESSAGE = "AI draft ready — review and save. Nothing was published or sent.";

/**
 * "Generate AI Recap" response → what the panel shows. Success ONLY when the
 * server returned a non-empty draft: the draft goes into the textarea and the
 * success message appears together. Anything else is a failure message (the
 * standard recap stays available).
 */
export function aiDraftOutcome(res: { ok: boolean; data: unknown }): { kind: "draft"; text: string; message: string } | { kind: "failed"; message: string } {
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as { text?: unknown; error?: unknown };
  if (res.ok && typeof data.text === "string" && data.text.trim().length > 0) {
    return { kind: "draft", text: data.text, message: AI_DRAFT_READY_MESSAGE };
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
}): Promise<"draft" | "failed"> {
  deps.setError(null);
  deps.notify(null);
  let outcome: ReturnType<typeof aiDraftOutcome>;
  try {
    outcome = aiDraftOutcome(await deps.request({ action: "generate_recap" }));
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

export type MvpStage =
  | "RESULT_NOT_PUBLISHED"
  | "NEEDS_TELEGRAM_GROUP"
  | "WAITING_FOR_MANAGER"
  | "READY_TO_START"
  | "OPEN"
  | "CLOSED"
  | "PUBLISHED";

/**
 * Player-of-the-Match card state. MVP is decided by a vote among the
 * published-team participants (Telegram poll); there is no free-text MVP.
 */
export function mvpStage(
  pg: { result: { published: boolean } | null; mvp: { started: boolean; open: boolean; closed: boolean; published: boolean } | null; messages: { destinationConnected: boolean } | null },
  canManage: boolean
): MvpStage {
  if (!pg.result?.published) return "RESULT_NOT_PUBLISHED";
  if (pg.mvp?.published) return "PUBLISHED";
  if (pg.mvp?.closed) return "CLOSED";
  if (pg.mvp?.open) return "OPEN";
  if (!canManage || !pg.messages) return "WAITING_FOR_MANAGER";
  if (!pg.messages.destinationConnected) return "NEEDS_TELEGRAM_GROUP";
  return "READY_TO_START";
}

/** DOM id of the Match's Telegram-group selector (Attendance section), for "Choose Telegram group". */
export const MATCH_TELEGRAM_GROUP_SELECTOR_ID = "match-telegram-group";
