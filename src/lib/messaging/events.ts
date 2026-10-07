/**
 * M6-B foundation — core business messages, independent of any channel.
 *
 *   core event (this file) → channel-neutral content (content.ts)
 *     → channel renderer/adapter (telegram.ts today; WhatsApp/email later)
 *
 * Deliberately tiny: no bus, no queue, no persistence. Delivery safety
 * (claim → send → confirm) stays with the caller — for Telegram teams
 * posts that is still the TelegramPoll.teamsPostStatus state machine in
 * src/lib/telegramCloseAndPost.ts (generalized per-channel delivery
 * records are a later M6-B batch).
 *
 * Reserved for later milestones (not implemented): MATCH_RESULT_POSTED,
 * MVP_VOTING_OPENED, MVP_SELECTED.
 */

export type TeamsForMessage = Array<{
  teamNumber: number;
  players: Array<{ firstName?: string | null; lastName?: string | null }>;
}>;

export type MessagingEvent =
  | {
      type: "POLL_CREATED";
      /** Game date, YYYY-MM-DD (date-only). */
      pollDate: string;
      /** Organizer-supplied question; blank → the default question. */
      customQuestion?: string | null;
    }
  | {
      type: "TEAMS_PUBLISHED";
      /** Already-formatted game date for display (e.g. "10/5/26"). */
      displayDate: string;
      teams: TeamsForMessage;
      /** Player-facing page for these teams, or null (see links.ts). */
      viewUrl?: string | null;
      /** M9.2 — the Match's venue (never part of the delivery content hash). */
      location?: { name: string; address: string | null; mapsUrl: string | null } | null;
    };

export type MessagingEventType = MessagingEvent["type"];
