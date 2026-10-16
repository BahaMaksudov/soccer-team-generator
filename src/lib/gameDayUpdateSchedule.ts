import { STALE_SENDING_MS } from "@/lib/messaging/deliveryState";

/**
 * Phase 4B (step 6) — WHEN a Game Day Update may be sent. Pure (no DB, no clock):
 * the automation step (just before sending) and the match page (status) both use
 * this one decision, from the current database facts.
 *
 *   dueAt  = max(deadline − hoursBefore, poll posted + 60 min)
 *   send while  now ≥ dueAt  and  deadline − now ≥ 30 min   (late cron runs still send while eligible)
 *   never after the deadline; one successful update per match (SENT is final, also
 *   if the deadline changes later); UNCERTAIN (or an abandoned SENDING) is never
 *   retried automatically; a definite FAILED attempt is retried while eligible —
 *   except when Telegram says the poll message to reply to is gone (terminal: the
 *   update is only ever sent as a reply to the poll).
 *
 * Manual "Send Game Day Update now" (manualGameDayDecision) — the organizer's
 * explicit, confirmed action: the same delivery-state, plan, match, deadline,
 * destination and 30-minute rules, but independent of the Group's automatic
 * setting, of the due time (no offset, no 60-minute poll settle) and of a
 * paused recurring schedule. Both share one MessageDelivery event per match, so
 * at most one update is ever SENT — manual or automatic.
 *
 * Destination consistency (both): the poll's chat must be the match's selected
 * Telegram group; otherwise nothing is sent (never a silent switch).
 */
/** FAILED codes that must not be retried automatically. */
export const TERMINAL_FAILURES = ["REPLY_TARGET_MISSING"] as const;
export const POLL_SETTLE_MS = 60 * 60_000;
export const MIN_LEFT_MS = 30 * 60_000;

export type GameDayDelivery = { status: "SENDING" | "SENT" | "FAILED" | "UNCERTAIN"; claimedAt: Date; sentAt: Date | null; failedAt: Date | null; failureCode?: string | null };

export type GameDayFacts = {
  enabled: boolean;
  hoursBefore: number;
  telegramAllowed: boolean;
  matchStatus: "SCHEDULED" | "COMPLETED" | "CANCELED";
  attendanceClosedAt: Date | null;
  attendanceDeadlineAt: Date | null;
  /** "none" for manual matches. */
  schedule: "none" | "active" | "paused";
  /**
   * The match's current (latest open) Telegram attendance poll, whether its chat is still connected, and
   * whether that chat IS the match's selected Telegram group (destination consistency).
   */
  poll: { postedAt: Date; chatConnected: boolean; chatMatchesMatch: boolean } | null;
  /** The latest Game Day Update delivery of this match (any destination). */
  delivery: GameDayDelivery | null;
  /**
   * M11.3 — automatic sends only: Telegram has been available without a break since
   * this instant (telegramEntitledSince). A due time before it fell while the
   * organization was on Free → never sent late. null/undefined = no restriction.
   */
  entitledSince?: Date | null;
};

export type GameDayBlock =
  | "SENT"
  | "UNCERTAIN"
  | "SENDING"
  | "DISABLED"
  | "NOT_IN_PLAN"
  | "INACTIVE"
  | "CLOSED"
  | "NO_DEADLINE"
  | "SCHEDULE_PAUSED"
  | "NO_POLL"
  | "CHAT_DISCONNECTED"
  | "CHAT_MISMATCH"
  | "POLL_MESSAGE_MISSING"
  | "TOO_CLOSE"
  | "MISSED_WHILE_FREE";

export type GameDayDecision =
  | { kind: "send"; dueAt: Date; retry: boolean }
  | { kind: "wait"; dueAt: Date }
  | { kind: "blocked"; reason: GameDayBlock; at?: Date | null };

export function gameDayUpdateDecision(f: GameDayFacts, now: Date): GameDayDecision {
  const d = f.delivery;
  const blocked = deliveryBlock(d, now);
  if (blocked) return blocked;
  if (!f.enabled) return { kind: "blocked", reason: "DISABLED" };
  if (!f.telegramAllowed) return { kind: "blocked", reason: "NOT_IN_PLAN" };
  if (f.matchStatus !== "SCHEDULED") return { kind: "blocked", reason: "INACTIVE" };
  if (f.attendanceClosedAt) return { kind: "blocked", reason: "CLOSED" };
  if (!f.attendanceDeadlineAt) return { kind: "blocked", reason: "NO_DEADLINE" };
  const deadline = f.attendanceDeadlineAt.getTime();
  if (deadline <= now.getTime()) return { kind: "blocked", reason: "CLOSED" };
  if (f.schedule === "paused") return { kind: "blocked", reason: "SCHEDULE_PAUSED" };
  if (!f.poll) return { kind: "blocked", reason: "NO_POLL" };
  if (!f.poll.chatConnected) return { kind: "blocked", reason: "CHAT_DISCONNECTED" };
  if (!f.poll.chatMatchesMatch) return { kind: "blocked", reason: "CHAT_MISMATCH" };
  const dueAt = new Date(Math.max(deadline - f.hoursBefore * 3600_000, f.poll.postedAt.getTime() + POLL_SETTLE_MS));
  const latest = deadline - MIN_LEFT_MS;
  if (dueAt.getTime() > latest) return { kind: "blocked", reason: "TOO_CLOSE", at: dueAt };
  if (f.entitledSince && dueAt.getTime() < f.entitledSince.getTime()) return { kind: "blocked", reason: "MISSED_WHILE_FREE", at: dueAt };
  if (now.getTime() < dueAt.getTime()) return { kind: "wait", dueAt };
  if (now.getTime() > latest) return { kind: "blocked", reason: "TOO_CLOSE", at: dueAt };
  return { kind: "send", dueAt, retry: d?.status === "FAILED" };
}

/** The delivery-state blocks both decisions share (one successful update per match; UNCERTAIN never re-sent). */
function deliveryBlock(d: GameDayDelivery | null, now: Date): Extract<GameDayDecision, { kind: "blocked" }> | null {
  if (d?.status === "SENT") return { kind: "blocked", reason: "SENT", at: d.sentAt };
  if (d?.status === "UNCERTAIN") return { kind: "blocked", reason: "UNCERTAIN", at: d.failedAt ?? d.claimedAt };
  if (d?.status === "SENDING") {
    const stale = now.getTime() - d.claimedAt.getTime() > STALE_SENDING_MS;
    return { kind: "blocked", reason: stale ? "UNCERTAIN" : "SENDING", at: d.claimedAt };
  }
  if (d?.status === "FAILED" && (TERMINAL_FAILURES as readonly string[]).includes(d.failureCode ?? "")) return { kind: "blocked", reason: "POLL_MESSAGE_MISSING", at: d.failedAt };
  return null;
}

export type ManualGameDayDecision = { kind: "ready"; retry: boolean } | Extract<GameDayDecision, { kind: "blocked" }>;

/** The organizer's explicit "Send now": everything but the automatic setting, the due time and a paused schedule. */
export function manualGameDayDecision(f: GameDayFacts, now: Date): ManualGameDayDecision {
  const blocked = deliveryBlock(f.delivery, now);
  if (blocked) return blocked;
  if (!f.telegramAllowed) return { kind: "blocked", reason: "NOT_IN_PLAN" };
  if (f.matchStatus !== "SCHEDULED") return { kind: "blocked", reason: "INACTIVE" };
  if (f.attendanceClosedAt) return { kind: "blocked", reason: "CLOSED" };
  if (!f.attendanceDeadlineAt) return { kind: "blocked", reason: "NO_DEADLINE" };
  const deadline = f.attendanceDeadlineAt.getTime();
  if (deadline <= now.getTime()) return { kind: "blocked", reason: "CLOSED" };
  if (!f.poll) return { kind: "blocked", reason: "NO_POLL" };
  if (!f.poll.chatConnected) return { kind: "blocked", reason: "CHAT_DISCONNECTED" };
  if (!f.poll.chatMatchesMatch) return { kind: "blocked", reason: "CHAT_MISMATCH" };
  if (deadline - now.getTime() < MIN_LEFT_MS) return { kind: "blocked", reason: "TOO_CLOSE" };
  return { kind: "ready", retry: f.delivery?.status === "FAILED" };
}

/** Organizer-facing status (no tokens, ids or provider details). Times are formatted by the caller in the Group's timezone. */
export const GAME_DAY_STATUS_TEXT: Record<GameDayBlock | "WAIT" | "DUE" | "RETRY", string> = {
  SENT: "Sent",
  UNCERTAIN: "Delivery uncertain — review the Telegram chat",
  SENDING: "Sending…",
  DISABLED: "Disabled in Group Settings",
  NOT_IN_PLAN: "Not available on your plan (Telegram is part of Pro)",
  INACTIVE: "Not sent: the match isn't scheduled",
  CLOSED: "Not sent: attendance is closed",
  NO_DEADLINE: "No attendance deadline",
  SCHEDULE_PAUSED: "Paused with the recurring schedule",
  NO_POLL: "No Telegram attendance poll",
  CHAT_DISCONNECTED: "Not sent: the poll's Telegram group is disconnected",
  CHAT_MISMATCH: "Not sent: the attendance poll is in a different Telegram group than this match's selected group",
  POLL_MESSAGE_MISSING: "Not sent: the attendance poll message is no longer in the Telegram group",
  TOO_CLOSE: "Not sent: too close to the deadline",
  MISSED_WHILE_FREE: "Not sent: it was due while the organization was on the Free plan",
  WAIT: "Scheduled",
  DUE: "Due — sent on the next automation run",
  RETRY: "Last attempt failed — retried on the next automation run",
};
