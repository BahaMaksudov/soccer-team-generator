import { createHash } from "node:crypto";
import { escapeHtml, renderTelegramHtml } from "./telegram";
import { formatPollQuestionDate } from "./content";

/**
 * M9-D — Telegram rendering of the post-game RESULT and the combined MATCH
 * SUMMARY, built only from canonical PUBLISHED data. Every dynamic value is
 * HTML-escaped; no ids appear. The delivery content hash is computed from the
 * published DATA (+ a format version), not from the rendered text, so the
 * link (and its share token) is never hashed and a cosmetic wording change
 * does not falsely mark a posted message as "updated".
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Safety margin below Telegram's 4096-character text limit. */
export const SUMMARY_TEXT_BUDGET = 3900;
const FORMAT_VERSION = 1;

export type Score = { teamNumber: number; score: number };
export type PostGameFacts = {
  date: string; // YYYY-MM-DD
  sportEmoji: string; // from the sport registry (⚽ 🏀 🏐 🏈 🏅)
  scores: Score[];
  venue: string | null;
};
/**
 * `contentHash` is what a new delivery stores; `acceptedHashes` are ALL hashes
 * that mean "this exact published content was already posted" (the current
 * one plus equivalent hashes of older message formats of the SAME data), used
 * for duplicate detection and the admin "posted / updated" state alike.
 */
export type RenderedMessage = { html: string; plainLength: number; contentHash: string; acceptedHashes: string[] };

type Line = { text: string; bold?: boolean } | { link: { label: string; url: string } } | { blank: true };

function render(lines: Line[]): { html: string; plainLength: number } {
  const html: string[] = [];
  let plain = 0;
  for (const l of lines) {
    if ("blank" in l) {
      html.push("");
    } else if ("link" in l) {
      html.push(`<a href="${escapeHtml(l.link.url).replaceAll('"', "&quot;")}">${escapeHtml(l.link.label)}</a>`);
      plain += l.link.label.length;
    } else {
      html.push(l.bold ? `<b>${escapeHtml(l.text)}</b>` : escapeHtml(l.text));
      plain += l.text.length;
    }
    plain += 1; // newline
  }
  // Collapse leading/trailing/duplicate blank lines.
  const out = html.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { html: out, plainLength: plain };
}

/** Same authoritative outcome logic as the Match page: a unique top score wins, otherwise a draw. */
export function outcomeOf(scores: Score[]): { kind: "WIN"; teamNumber: number } | { kind: "DRAW" } {
  const top = Math.max(...scores.map((s) => s.score));
  const leaders = scores.filter((s) => s.score === top);
  return leaders.length === 1 ? { kind: "WIN", teamNumber: leaders[0].teamNumber } : { kind: "DRAW" };
}

/** Two teams → one head-to-head scoreboard line; more → standings lines (highest first). */
export function scoreboardLines(sportEmoji: string, scores: Score[]): string[] {
  const byTeam = [...scores].sort((a, b) => a.teamNumber - b.teamNumber);
  if (byTeam.length === 2) {
    const [a, b] = byTeam;
    return [`${sportEmoji} Team ${a.teamNumber}  ${a.score} — ${b.score}  Team ${b.teamNumber}`];
  }
  return [...byTeam].sort((a, b) => b.score - a.score || a.teamNumber - b.teamNumber).map((s) => `Team ${s.teamNumber} — ${s.score}`);
}

export function outcomeLine(scores: Score[]): string {
  const o = outcomeOf(scores);
  return o.kind === "WIN" ? `🏆 Team ${o.teamNumber} wins!` : "🤝 Draw";
}

/**
 * Hash of the first (pre-scoreboard, "🏁 Final Result … • Team 1: 5") result
 * message for the same published data — the rendered-text hash its SENT
 * deliveries stored. Reconstructed byte-for-byte (link excluded, as then).
 */
export function legacyResultHash(f: Pick<PostGameFacts, "date" | "scores">): string {
  const sorted = [...f.scores].sort((a, b) => a.teamNumber - b.teamNumber);
  const top = Math.max(...sorted.map((s) => s.score));
  const leaders = sorted.filter((s) => s.score === top);
  const html = renderTelegramHtml({
    kind: "text",
    title: `\u{1F3C1} Final Result — ${formatPollQuestionDate(f.date)}`,
    body: leaders.length === 1 ? `Team ${leaders[0].teamNumber} wins!` : "It's a draw!",
    sections: [{ heading: "Score", items: sorted.map((s) => `Team ${s.teamNumber}: ${s.score}`) }],
    link: null,
  });
  return createHash("sha256").update(html, "utf8").digest("hex");
}

const hashData = (data: unknown) => createHash("sha256").update(JSON.stringify({ v: FORMAT_VERSION, ...(data as object) }), "utf8").digest("hex");
const scoresKey = (scores: Score[]) => [...scores].sort((a, b) => a.teamNumber - b.teamNumber).map((s) => [s.teamNumber, s.score]);

/** THE canonical Result delivery hashes (send, duplicate detection and admin state all use this). */
export function resultDeliveryHashes(f: PostGameFacts): { contentHash: string; acceptedHashes: string[] } {
  const contentHash = hashData({ kind: "result", date: f.date, scores: scoresKey(f.scores), venue: f.venue });
  return { contentHash, acceptedHashes: [contentHash, legacyResultHash(f)] };
}

/** THE canonical Match Summary delivery hash (send, duplicate detection and admin state all use this). */
export function summaryDeliveryHashes(f: PostGameFacts & { mvpNames: string[]; recap: string | null }): { contentHash: string; acceptedHashes: string[] } {
  const contentHash = hashData({ kind: "summary", date: f.date, scores: scoresKey(f.scores), mvp: f.mvpNames, recap: f.recap, venue: f.venue });
  return { contentHash, acceptedHashes: [contentHash] };
}

/** 🏁 FINAL SCORE — scoreboard, winner/draw, venue, link. */
export function renderResultMessage(f: PostGameFacts, viewUrl: string | null): RenderedMessage {
  const lines: Line[] = [
    { text: `🏁 FINAL SCORE — ${formatPollQuestionDate(f.date)}`, bold: true },
    { blank: true },
    ...scoreboardLines(f.sportEmoji, f.scores).map((text) => ({ text })),
    { blank: true },
    { text: outcomeLine(f.scores) },
    ...(f.venue ? [{ text: `📍 ${f.venue}` }] : []),
    ...(viewUrl ? [{ blank: true } as Line, { link: { label: "View match", url: viewUrl } }] : []),
  ];
  return { ...render(lines), ...resultDeliveryHashes(f) };
}

/**
 * 🏁 MATCH COMPLETE — score, winner/draw, Player(s) of the Match (if
 * published), recap (if published), venue, link. Only the recap is ever
 * shortened, so the whole text stays within Telegram's limit; score,
 * outcome, MVP names and the link are never cut.
 */
export function renderSummaryMessage(f: PostGameFacts & { mvpNames: string[]; recap: string | null }, viewUrl: string | null): RenderedMessage {
  const build = (recap: string | null): Line[] => [
    { text: `🏁 MATCH COMPLETE — ${formatPollQuestionDate(f.date)}`, bold: true },
    { blank: true },
    ...scoreboardLines(f.sportEmoji, f.scores).map((text) => ({ text })),
    { text: outcomeLine(f.scores) },
    ...(f.mvpNames.length
      ? [{ blank: true } as Line, { text: f.mvpNames.length > 1 ? "⭐ Players of the Match" : "⭐ Player of the Match", bold: true }, ...f.mvpNames.map((text) => ({ text }))]
      : []),
    ...(recap ? [{ blank: true } as Line, { text: "📝 Match Recap", bold: true }, { text: recap }] : []),
    ...(f.venue ? [{ blank: true } as Line, { text: `📍 ${f.venue}` }] : []),
    ...(viewUrl ? [{ blank: true } as Line, { link: { label: "View match", url: viewUrl } }] : []),
  ];
  let recap = f.recap;
  let r = render(build(recap));
  if (recap && r.plainLength > SUMMARY_TEXT_BUDGET) {
    const keep = Math.max(0, recap.length - (r.plainLength - SUMMARY_TEXT_BUDGET) - 1);
    recap = keep > 0 ? `${recap.slice(0, keep).trimEnd()}…` : null;
    r = render(build(recap));
  }
  return { ...r, ...summaryDeliveryHashes(f) };
}
