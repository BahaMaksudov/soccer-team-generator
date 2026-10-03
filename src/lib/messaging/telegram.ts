import type { PollContent, TextContent } from "./content";

/**
 * Telegram renderer/adapter for channel-neutral content. Output for
 * content without a link is byte-identical to the pre-M6 teams message
 * (asserted in tests), so existing Close/Post behavior is unchanged.
 */

export function escapeHtml(s: string): string {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const escapeAttr = (s: string) => escapeHtml(s).replaceAll('"', "&quot;");

/** Telegram Bot API sendMessage text with parse_mode=HTML. */
export function renderTelegramHtml(content: TextContent): string {
  const lines: string[] = [`<b>${escapeHtml(content.title)}</b>`, ""];
  if (content.body) lines.push(escapeHtml(content.body), "");
  for (const section of content.sections) {
    lines.push(`<b>${escapeHtml(section.heading)}</b>`);
    for (const item of section.items) lines.push(`• ${escapeHtml(item)}`);
    lines.push("");
  }
  let text = lines.join("\n").trim();
  if (content.link) {
    text += `\n\n<a href="${escapeAttr(content.link.url)}">${escapeHtml(content.link.label)}</a>`;
  }
  return text;
}

/** Telegram Bot API sendPoll parameters (excluding chat_id). */
export function renderTelegramPoll(content: PollContent) {
  return {
    question: content.question,
    options: content.options,
    is_anonymous: false,
    allows_multiple_answers: false,
  };
}
