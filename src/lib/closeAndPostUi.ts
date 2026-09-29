import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatYMDFromDate } from "@/lib/telegramFormat";

/**
 * Phase 2D.6D.5D — pure, framework-free helpers for the canonical
 * "Close Poll & Post Teams to Telegram" UI. Kept out of the React
 * components so the state contract is unit-testable in this repo's
 * node-only vitest environment (same approach as
 * telegramImportSelection.ts). UX only — the server is authoritative.
 */

/** The TeamGeneration the current canonical Admin workflow just published. */
export type PublishedGeneration = {
  id: string;
  /** YYYY-MM-DD (UTC calendar day, as the server stores it). */
  date: string;
};

/**
 * Builds the workspace's publishedGeneration from a successful canonical
 * Publish response. `previewDate` is the ISO date Generate returned and
 * Publish sent; the server stores it via toDateOnlyUTC(), mirrored here.
 */
export function publishedGenerationFromPublishResponse(
  data: unknown,
  previewDate: string
): PublishedGeneration | null {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return null;
  const d = toDateOnlyUTC(previewDate);
  if (Number.isNaN(d.getTime())) return null;
  return { id, date: formatYMDFromDate(d) };
}

/**
 * Close/Post eligibility. Deliberately takes ONLY the poll's
 * `persistedPollDate` (the TelegramPoll.pollDate column as returned by
 * the canonical polls API) — never the question-text-derived
 * `pollDate` display field — so date-looking question text can never
 * make a poll eligible. A poll with no persisted date is never
 * eligible, mirroring the server's pollDate=null rejection.
 */
export function canCloseAndPost(args: {
  poll: { persistedPollDate: string | null } | null | undefined;
  publishedGeneration: PublishedGeneration | null;
  running: boolean;
}): boolean {
  const { poll, publishedGeneration, running } = args;
  const persistedPollDate = poll?.persistedPollDate ?? null;
  if (running || !publishedGeneration || !persistedPollDate) return false;
  return persistedPollDate === publishedGeneration.date;
}

export type CloseAndPostOutcome = {
  tone: "success" | "warning" | "error";
  message: string;
};

const CLOSE_NOTES: Record<string, string> = {
  closed_now: "Poll closed.",
  already_closed_locally: "Poll was already closed.",
  already_closed_on_telegram: "Poll was already closed on Telegram.",
  missing_message_id: "Poll could not be closed (no Telegram message id).",
  close_failed: "Poll could not be closed on Telegram.",
};

/**
 * Turns a close-and-post response into a single banner. Never suggests
 * an automatic retry for an ambiguous outcome.
 */
export function describeCloseAndPostResult(httpOk: boolean, data: unknown): CloseAndPostOutcome {
  const d = (data ?? {}) as { status?: string; closeStatus?: string | null; error?: string };
  const closeNote = d.closeStatus ? CLOSE_NOTES[d.closeStatus] ?? "" : "";
  const withClose = (s: string) => (closeNote ? `${closeNote} ${s}` : s);
  const serverError = d.error ?? "";

  switch (d.status) {
    case "posted":
      return { tone: "success", message: withClose("✅ Teams posted to Telegram.") };
    case "already_posted":
      return { tone: "success", message: withClose("✅ These teams were already posted to Telegram. Nothing was sent again.") };
    case "already_posted_different_generation":
      return {
        tone: "error",
        message: "Different teams were already posted for this poll. Nothing was sent.",
      };
    case "post_in_progress_or_unknown":
      return {
        tone: "warning",
        message:
          "⚠️ A previous post for this poll may already have reached Telegram. Check the chat — do not retry automatically.",
      };
    case "claim_conflict":
      return { tone: "warning", message: "The poll's posting state changed during the request. Nothing was sent. Reload and check." };
    case "telegram_rejected":
      return { tone: "error", message: withClose(serverError || "Telegram rejected the teams message. Nothing was posted.") };
    case "delivery_unknown":
      return {
        tone: "warning",
        message: withClose(
          "⚠️ Could not confirm whether Telegram received the teams message. Check the chat — do not retry automatically."
        ),
      };
    case "delivered_confirmation_failed":
      return {
        tone: "warning",
        message: withClose(
          "⚠️ Telegram accepted the teams message, but it could not be recorded as posted. Do not retry — the teams are already in the chat."
        ),
      };
    default:
      return {
        tone: httpOk ? "success" : "error",
        message: serverError || (httpOk ? "Done." : "Failed to close poll and post teams."),
      };
  }
}
