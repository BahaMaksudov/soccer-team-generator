import type { MessagingEvent } from "./events";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * Channel-neutral content. Renderers turn this into a specific channel's
 * payload; business wording lives only here, so a new channel never
 * copies it.
 */

/** Option 0 means "playing" — import relies on this index (telegramFormat.isPlayingVote). */
export const POLL_OPTIONS = ["✅ Playing", "❌ Not playing"] as const;

/**
 * M9-A — Match-linked attendance polls add "Maybe" at index 2 (appended, so
 * indexes 0/1 keep their meaning for legacy two-option polls and import).
 */
export const ATTENDANCE_POLL_OPTIONS = [...POLL_OPTIONS, "🤔 Maybe"] as const;

/** "20:00" → "8:00 PM" (display only). */
export function formatStartTime(hhmm: string | null | undefined): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** M9-A — attendance poll for a Match (Telegram question limit: 300 characters). */
export function attendancePollContent(match: { date: string; startTime?: string | null; locationName?: string | null }): PollContent {
  const time = formatStartTime(match.startTime);
  let question = `Who is playing on ${formatPollQuestionDate(match.date)}${time ? ` at ${time}` : ""}${match.locationName ? ` — ${match.locationName}` : ""}?`;
  if (question.length > 300) question = `${question.slice(0, 298)}…?`;
  return { kind: "poll", question, options: [...ATTENDANCE_POLL_OPTIONS] };
}

export type PollContent = { kind: "poll"; question: string; options: string[] };
export type TextContent = {
  kind: "text";
  title: string;
  /** M9-D — optional plain-text paragraph(s) after the title (absent for teams: their rendering is unchanged). */
  body?: string;
  sections: Array<{ heading: string; items: string[] }>;
  /** M9.2 — venue line(s) after the sections ("📍 Name" + a maps link for the address). */
  location?: { name: string; address: string | null; mapsUrl: string | null } | null;
  link: { label: string; url: string } | null;
};

/** YYYY-MM-DD → M/D/YY (no leading zeros), the poll question's date style. */
export function formatPollQuestionDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(-2)}`;
}

export function pollContent(event: Extract<MessagingEvent, { type: "POLL_CREATED" }>): PollContent {
  const question = event.customQuestion?.trim() || `Who is playing on ${formatPollQuestionDate(event.pollDate)}?`;
  return { kind: "poll", question, options: [...POLL_OPTIONS] };
}

/**
 * M7: deliberately sport-neutral and byte-identical to pre-M7 — the
 * delivery state compares contentHash(body), so changing this wording
 * would make every already-posted teams message look "changed". New
 * sport-aware wording (emoji, game noun, result label) is read from the
 * Group's SportDefinition via messagingVocabulary() by M9 events.
 */
export function teamsContent(event: Extract<MessagingEvent, { type: "TEAMS_PUBLISHED" }>): TextContent {
  return {
    kind: "text",
    title: `\u{1F3DF}\u{FE0F} Generated Teams — ${event.displayDate}`,
    sections: event.teams.map((t) => ({
      heading: `Team #${t.teamNumber}`,
      items: (Array.isArray(t.players) ? t.players : []).map((p) => playerDisplayName(p ?? {})),
    })),
    location: event.location ?? null,
    link: event.viewUrl ? { label: "View teams online", url: event.viewUrl } : null,
  };
}

// ------------------------------------------------------------------ M9-D
// Deterministic post-game messages. Only verified, published facts; sport-
// neutral wording; no vote totals. The link (if any) is never part of the
// content hash (callers hash the body rendered WITHOUT the link).

/** Telegram: 1–100 characters per option; ≤ 10 options (the conservative documented maximum). */
export const MVP_POLL_MAX_OPTIONS = 10;

export function mvpPollContent(params: { date: string; names: string[] }): PollContent {
  return {
    kind: "poll",
    question: `🏆 Player of the Match — ${formatPollQuestionDate(params.date)}?`,
    options: params.names.map((n) => (n.length > 100 ? `${n.slice(0, 99)}…` : n)),
  };
}

export function mvpAnnouncementContent(params: { names: string[]; viewUrl: string | null }): TextContent {
  return {
    kind: "text",
    title: params.names.length > 1 ? "\u{1F3C6} Players of the Match" : "\u{1F3C6} Player of the Match",
    body: "Thanks for voting!",
    sections: [{ heading: params.names.length > 1 ? "Co-MVPs" : "MVP", items: params.names }],
    link: params.viewUrl ? { label: "View match", url: params.viewUrl } : null,
  };
}

export function recapContent(params: { date: string; text: string; viewUrl: string | null }): TextContent {
  return {
    kind: "text",
    title: `\u{1F4DD} Match Recap — ${formatPollQuestionDate(params.date)}`,
    body: params.text,
    sections: [],
    link: params.viewUrl ? { label: "View match", url: params.viewUrl } : null,
  };
}
