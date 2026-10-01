import type { MessagingEvent } from "./events";
import { playerDisplayName } from "@/lib/playerFacing";

/**
 * Channel-neutral content. Renderers turn this into a specific channel's
 * payload; business wording lives only here, so a new channel never
 * copies it.
 */

/** Option 0 means "playing" — import relies on this index (telegramFormat.isPlayingVote). */
export const POLL_OPTIONS = ["✅ Playing", "❌ Not playing"] as const;

export type PollContent = { kind: "poll"; question: string; options: string[] };
export type TextContent = {
  kind: "text";
  title: string;
  sections: Array<{ heading: string; items: string[] }>;
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
    link: event.viewUrl ? { label: "View teams online", url: event.viewUrl } : null,
  };
}
