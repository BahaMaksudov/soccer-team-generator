/**
 * Pure, framework-free Telegram formatting/parsing helpers.
 * No fetch, no Prisma — safe to import from server routes, client
 * components, and unit tests alike.
 */

export function escapeHtml(s: string): string {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export type TeamForMessage = {
  teamNumber: number;
  players: Array<{ firstName?: string | null; lastName?: string | null }>;
};

export function formatTeamsHtml(displayDate: string, teams: TeamForMessage[]): string {
  const title = `<b>\u{1F3DF}\u{FE0F} Generated Teams — ${escapeHtml(displayDate)}</b>`;
  const lines: string[] = [title, ""];

  for (const t of teams) {
    lines.push(`<b>Team #${escapeHtml(String(t.teamNumber))}</b>`);
    const players = Array.isArray(t.players) ? t.players : [];
    for (const p of players) {
      const first = (p?.firstName ?? "").toString().trim();
      const last = (p?.lastName ?? "").toString().trim();
      const name = `${first} ${last}`.trim() || "Unknown";
      lines.push(`• ${escapeHtml(name)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** Telegram's message length cap is 4096 chars; split on line boundaries. */
export function splitTelegramText(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const lines = text.split("\n");
  let buf = "";
  for (const line of lines) {
    if ((buf + "\n" + line).length > max) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Formats a UTC-midnight Date as Telegram's "M/D/YY" display format.
 * Safe to call from client components: only ever reads UTC calendar
 * components (getUTCMonth/getUTCDate/getUTCFullYear), never local
 * getters, so a "YYYY-MM-DD" input parsed via `new Date(...)` (always
 * interpreted as UTC midnight per spec) can never shift by a day
 * regardless of the caller's local timezone.
 * Returns "" for an invalid Date rather than a garbage "NaN/NaN/aN" string.
 */
export function formatMDYYFromDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

export function formatMDYYFromISO(dateStr: string): string {
  return formatMDYYFromDate(new Date(dateStr));
}

/**
 * Formats a Date as a machine-readable YYYY-MM-DD calendar string, using
 * the Date's UTC calendar components — never the runtime's local
 * timezone. TelegramPoll.pollDate (like TeamGeneration.date) is always
 * stored as UTC midnight via toDateOnlyUTC(); reading it back with
 * local getters (getMonth/getDate/getFullYear) would shift the result
 * by a day for any server running west of UTC. Mirrors the same
 * UTC-getter discipline as src/lib/dateOnly.ts.
 */
export function formatYMDFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Legacy-compatibility only: recovers a date from a poll's free-text
 * question, e.g. "Who is playing on 1/19/26?" -> "1/19/26".
 * Prefer TelegramPoll.pollDate wherever it's available — see
 * resolvePollDisplayDate() / resolvePollCalendarDate() below.
 */
export function parsePollDateFromQuestion(question?: string | null): string | null {
  if (!question) return null;
  const m = question.match(/\bon\s+(\d{1,2}\/\d{1,2}\/\d{2})\b/i);
  return m?.[1] ?? null;
}

/** Converts "M/D/YY" (e.g. "1/26/26") to "YYYY-MM-DD" (e.g. "2026-01-26"). */
function mdyyToYMD(mdyy: string): string | null {
  const m = mdyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  // These polls are always created for a near-term upcoming game (see
  // formatMDYYFromDate / formatMdyTwoDigitYear, both 2-digit-year
  // only) — a 2-digit year here always means 2000+yy.
  const year = 2000 + Number(m[3]);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type PollLike = { pollDate?: Date | string | null; question?: string | null } | null | undefined;

/**
 * Resolves the human-readable date to show for a Telegram poll/game.
 * Source-of-truth order:
 *   1) poll.pollDate         — the real column; always correct when present
 *   2) parsePollDateFromQuestion — fallback for legacy rows with pollDate = null
 *   3) fallbackDateStr        — last resort (e.g. the publish date)
 */
export function resolvePollDisplayDate(poll: PollLike, fallbackDateStr?: string | null): string {
  if (poll?.pollDate) {
    const d = poll.pollDate instanceof Date ? poll.pollDate : new Date(poll.pollDate);
    if (!Number.isNaN(d.getTime())) return formatMDYYFromDate(d);
  }
  const fromQuestion = parsePollDateFromQuestion(poll?.question);
  if (fromQuestion) return fromQuestion;
  if (fallbackDateStr) return formatMDYYFromISO(fallbackDateStr);
  return "unknown date";
}

/**
 * Resolves the machine-readable calendar date (YYYY-MM-DD) for a
 * Telegram poll/game — for populating a `<input type="date">` or any
 * other code that needs to compare/store the actual date, as opposed
 * to displaying it. Source-of-truth order:
 *   1) poll.pollDate — the real column; always correct when present
 *   2) parsePollDateFromQuestion, converted from M/D/YY — legacy
 *      fallback for rows with pollDate = null
 * Returns null (never "today", never the poll's createdAt) when
 * nothing is available — callers should leave a date field unset
 * rather than guess.
 */
export function resolvePollCalendarDate(poll: PollLike): string | null {
  if (poll?.pollDate) {
    const d = poll.pollDate instanceof Date ? poll.pollDate : new Date(poll.pollDate);
    if (!Number.isNaN(d.getTime())) return formatYMDFromDate(d);
  }
  const fromQuestion = parsePollDateFromQuestion(poll?.question);
  if (fromQuestion) return mdyyToYMD(fromQuestion);
  return null;
}

const PLAYING_OPTION_INDEX = 0;

/** True if a poll answer's parsed option-id array includes the "Playing" option (index 0). */
export function isPlayingVote(optionIdsJson: string): boolean {
  try {
    const arr = JSON.parse(optionIdsJson || "[]");
    return Array.isArray(arr) && arr.includes(PLAYING_OPTION_INDEX);
  } catch {
    return false;
  }
}
