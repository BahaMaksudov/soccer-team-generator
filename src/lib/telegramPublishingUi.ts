/**
 * Telegram publishing — what the Match Workspace shows for the persisted
 * states (pure; unit-tested). The buttons follow the SERVER state of the
 * selected chat; the server enforces the same rules, so a stale page can't
 * cause a duplicate.
 */
export type PollPostState = "not_posted" | "posting" | "posted" | "details_changed" | "failed" | "uncertain";
export type PollPostView = { state: PollPostState; at: string | null; otherChats: string[] };

export type PollButtonView = { label: string; enabled: boolean; done: boolean; note: string | null; warn: boolean };

export function pollButtonView(p: PollPostView | null | undefined, chatTitle: string | null): PollButtonView {
  const chat = chatTitle || "the Telegram group";
  switch (p?.state ?? "not_posted") {
    case "posting":
      return { label: "Posting…", enabled: false, done: false, note: null, warn: false };
    case "posted":
      return { label: "Poll posted", enabled: false, done: true, note: null, warn: false };
    case "failed":
      return { label: "Retry posting", enabled: true, done: false, note: `Telegram refused the last attempt — nothing was posted to ${chat}.`, warn: true };
    case "uncertain":
      return { label: "Post poll to Telegram", enabled: false, done: false, note: `Telegram didn't confirm the last attempt. Check ${chat} in Telegram before doing anything — it is never re-posted automatically.`, warn: true };
    case "details_changed":
      return { label: "Poll details changed", enabled: false, done: false, note: "The match's date, time or location changed after the poll was posted. Updating the poll needs an explicit action — nothing is reposted automatically.", warn: true };
    default:
      return { label: "Post poll to Telegram", enabled: true, done: false, note: null, warn: false };
  }
}

type CloseStatus = "closed_now" | "already_closed_locally" | "already_closed_on_telegram" | "missing_message_id" | "close_failed" | "close_uncertain" | null | undefined;
type NoticeStatus = "sent" | "failed" | "uncertain" | "exists" | null | undefined;

/** The poll / notice part of a "Post teams to Telegram" result — never claims a close that wasn't verified. */
export function pollCloseFeedback(closeStatus: CloseStatus, noticeStatus: NoticeStatus): string {
  const poll =
    closeStatus === "closed_now" || closeStatus === "already_closed_on_telegram"
      ? "The attendance poll is closed."
      : closeStatus === "already_closed_locally"
        ? "The attendance poll was already closed."
        : closeStatus === "close_uncertain"
          ? "Telegram didn't confirm that the attendance poll was closed — it may still be open. Use “Close Telegram poll” (safe to repeat)."
          : closeStatus === "close_failed" || closeStatus === "missing_message_id"
            ? "The attendance poll could NOT be closed — it is still open. Use “Close Telegram poll”."
            : "";
  const notice =
    noticeStatus === "sent"
      ? " Closure notice sent."
      : noticeStatus === "failed"
        ? " Telegram refused the closure notice — you can retry it."
        : noticeStatus === "uncertain"
          ? " The closure notice wasn't confirmed — check the group; it won't be sent again automatically."
          : "";
  return `${poll}${notice}`.trim();
}

/** The complete message after "Post teams to Telegram" (teams outcome first, then the poll part). */
export function closeAndPostFeedback(ok: boolean, data: { status?: string; error?: string; closeStatus?: CloseStatus; noticeStatus?: NoticeStatus }): string {
  const teams = ok
    ? data.status === "already_posted"
      ? "These teams were already posted — nothing was sent again."
      : "Teams posted to Telegram."
    : data.status === "telegram_rejected"
      ? "The teams message was NOT sent (Telegram refused it) — you can retry."
      : data.status === "delivery_unknown"
        ? "Telegram didn't confirm the teams message — check the group before doing anything."
        : (data.error ?? "Could not post the teams.");
  const poll = pollCloseFeedback(data.closeStatus, data.noticeStatus);
  return poll ? `${teams} ${poll}` : teams;
}
