export type { MessagingEvent, MessagingEventType, TeamsForMessage } from "./events";
export { POLL_OPTIONS, pollContent, teamsContent, formatPollQuestionDate, type PollContent, type TextContent } from "./content";
export { renderTelegramHtml, renderTelegramPoll } from "./telegram";
export { playerFacingViewUrl } from "./links";

/**
 * M7 — sport-aware vocabulary for channel-neutral content (M9/M10). Generic
 * messaging code must take emoji/game noun/result label from here (i.e.
 * from the Group's SportDefinition), never hard-code soccer terms.
 */
export { sportMessaging as messagingVocabulary } from "@/lib/sports";
