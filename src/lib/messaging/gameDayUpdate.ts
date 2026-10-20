import { escapeHtml } from "@/lib/messaging/telegram";
import { kickoffAt } from "@/lib/attendanceDeadline";
import { localYmd } from "@/lib/scheduleTime";

/**
 * Phase 4B (step 5) — the Telegram Game Day Update message. PURE: no database,
 * no network, no clock (the caller passes `now`). Telegram HTML (parse_mode
 * "HTML", as every other bot message); every caller-supplied string is cleaned
 * (control characters / line breaks → spaces, length-capped by code point) and
 * then HTML-escaped. Never includes player names or ratings — only counts.
 *
 * Time: everything is shown in the Group's timezone (DST-aware via Intl); the
 * "closes in …" text is the ACTUAL time left at `now` (a late cron run says so
 * honestly), never the configured offset. A deadline that is not in the future
 * yields no message.
 *
 * Weather is optional INPUT (never generated here): canonical metric values
 * from the provider adapter, converted to the Group's units; missing fields are
 * simply omitted. Compact: one conditions line ("Outside at kickoff", plus
 * "(indoor venue)" so nobody reads it as the weather inside), one rain · wind
 * line, the provider attribution, and the provider-required disclaimer kept
 * COMPLETE (verbatim) and always VISIBLE in a Telegram blockquote (not
 * collapsed — a collapsed disclaimer is not confirmed to satisfy the provider's
 * "clear, conspicuous" requirement).
 *
 * Attendance: the Attendance Summary over the eligible roster — Playing, Not
 * Playing, Maybe, Not Responded (the shared calculation; they add up to the
 * roster size shown).
 */
export const TELEGRAM_TEXT_LIMIT = 4096;
const CAP = { name: 80, venue: 80, condition: 60, attribution: 100, disclaimer: 1000 } as const;

export type GameDayWeather = {
  /** °C (converted to °F for imperial). */
  temperatureC?: number | null;
  condition?: string | null;
  /** 0–100. */
  rainChancePercent?: number | null;
  /** km/h (converted to mph for imperial). */
  windKph?: number | null;
  /** Provider attribution when its terms require one, e.g. "Weather by WeatherAPI.com". */
  attribution?: string | null;
  /** A linked attribution ("Powered by" + <a href=url>text</a>); https URLs only. Shown with the forecast. */
  attributionLink?: { before: string; text: string; url: string } | null;
  /** The provider-required end-user disclaimer — always included in full, visible, with the forecast. */
  disclaimer?: string | null;
};


export type GameDayUpdateInput = {
  groupName: string;
  /** The Group's public display name ("teamName"), preferred when set. */
  displayName?: string | null;
  /** IANA timezone of the Group. */
  timezone: string;
  /** Date-only "YYYY-MM-DD" + optional local "HH:MM" — the same for manual and recurring matches. */
  match: { date: string; startTime: string | null; venueName?: string | null; isIndoor?: boolean };
  /** The match's attendance deadline (the one shared deadline). */
  deadline: Date;
  /** Effective attendance over the eligible roster (organizer overrides included) — counts only. */
  attendance: { playing: number; notPlaying: number; maybe: number; noResponse: number };
  /**
   * M12B — the match's Telegram attendance poll: "open" → remind players to vote in it;
   * "closed" → say voting is closed; "none" → no poll claim. No website attendance
   * link is ever included (Telegram matches are answered in the poll only).
   */
  poll: "open" | "closed" | "none";
  weather?: GameDayWeather | null;
  units: "imperial" | "metric";
  now: Date;
};

export type GameDayUpdateMessage =
  | { ok: true; html: string; parseMode: "HTML"; disableWebPagePreview: true; truncated: boolean }
  | { ok: false; reason: "DEADLINE_PASSED" | "INVALID_INPUT" };

// C0/C1 control characters and the Unicode line / paragraph separators (written as escapes).
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");

/** Remove control characters and line breaks; cap by code points (never splits a surrogate pair). */
function clean(s: string | null | undefined, max: number): { text: string; truncated: boolean } {
  const flat = String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? { text: `${chars.slice(0, max - 1).join("").trimEnd()}…`, truncated: true } : { text: flat, truncated: false };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmt(at: Date, tz: string, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options }).formatToParts(at);
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
}

/** "9:00 PM EDT" */
function clock(at: Date, tz: string): string {
  const g = fmt(at, tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${g("hour")}:${g("minute")} ${g("dayPeriod")} ${g("timeZoneName")}`;
}

/** "Monday, October 19 · 9:00 PM EDT" (no time when the match has no start time). */
function kickoffLine(date: string, startTime: string | null, tz: string): string {
  const day = new Date(`${date}T12:00:00Z`); // the calendar date itself (date-only value)
  const g = fmt(day, "UTC", { weekday: "long", month: "long", day: "numeric" });
  const head = `${g("weekday")}, ${g("month")} ${g("day")}`;
  return startTime ? `${head} · ${clock(kickoffAt(new Date(`${date}T00:00:00Z`), startTime, tz), tz)}` : head;
}

/** "4 hours", "3 hours 20 minutes", "45 minutes", "1 minute", "2 days 3 hours". */
export function timeLeftText(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) {
    const d = Math.floor(hours / 24);
    const h = hours % 24;
    return h ? `${plural(d, "day")} ${plural(h, "hour")}` : plural(d, "day");
  }
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

/** "today at 5:00 PM EDT", else "on Sunday, October 18 at 5:00 PM EDT" (the group's timezone, DST-aware). */
function deadlineText(deadline: Date, now: Date, tz: string): string {
  if (localYmd(deadline, tz) === localYmd(now, tz)) return `today at ${clock(deadline, tz)}`;
  const g = fmt(deadline, tz, { weekday: "long", month: "long", day: "numeric" });
  return `on ${g("weekday")}, ${g("month")} ${g("day")} at ${clock(deadline, tz)}`;
}

/** M12B — what players do next, by the state of the match's Telegram attendance poll. */
export const POLL_REMINDER = "📊 Haven't voted yet? Please update your attendance directly in the Telegram poll before the deadline.";
export const POLL_CLOSED_LINE = "🔒 Attendance voting is closed.";
function pollLines(poll: "open" | "closed" | "none"): string[] {
  if (poll === "open") return ["", POLL_REMINDER];
  if (poll === "closed") return ["", POLL_CLOSED_LINE];
  return [];
}

function weatherLines(w: GameDayWeather | null | undefined, units: "imperial" | "metric", indoor: boolean, track: (t: boolean) => void): string[] {
  if (!w) return [];
  // The provider-required disclaimer goes with the forecast COMPLETE or not at all: without the full
  // text (missing, or too long to fit uncut) the message carries no weather — never a shortened disclaimer.
  const disclaimer = clean(w.disclaimer, CAP.disclaimer);
  if (!disclaimer.text || disclaimer.truncated) return [];
  const lines: string[] = [];
  const temp = finite(w.temperatureC) ? (units === "imperial" ? `${Math.round((w.temperatureC * 9) / 5 + 32)}°F` : `${Math.round(w.temperatureC)}°C`) : null;
  const cond = clean(w.condition, CAP.condition);
  track(cond.truncated);
  const main = [temp, cond.text ? cond.text.charAt(0).toLowerCase() + cond.text.slice(1) : null].filter(Boolean).join(", ");
  // Always "outside": for an indoor venue it says so explicitly (the forecast is never the hall's conditions).
  if (main) lines.push(`🌤 Outside at kickoff${indoor ? " (indoor venue)" : ""}: ${escapeHtml(main)}`);
  const extra = [
    finite(w.rainChancePercent) ? `🌧 Rain: ${Math.min(100, Math.max(0, Math.round(w.rainChancePercent)))}%` : null,
    finite(w.windKph) && w.windKph >= 0 ? `💨 Wind: ${units === "imperial" ? `${Math.round(w.windKph / 1.609344)} mph` : `${Math.round(w.windKph)} km/h`}` : null,
  ].filter(Boolean);
  if (extra.length) lines.push(extra.join(" · "));
  if (lines.length) {
    const attr = clean(w.attribution, CAP.attribution);
    track(attr.truncated);
    if (attr.text) lines.push(`<i>${escapeHtml(attr.text)}</i>`);
    const link = w.attributionLink;
    const url = link ? safeLink(link.url) : null;
    if (link && url) {
      const before = clean(link.before, CAP.attribution).text;
      const text = clean(link.text, CAP.attribution).text;
      if (text) lines.push(`<i>${before ? `${escapeHtml(before)} ` : ""}<a href="${escapeHtml(url).replaceAll('"', "&quot;")}">${escapeHtml(text)}</a></i>`);
    }
    // Fully visible (a plain quote, never collapsed) and verbatim.
    lines.push(`<blockquote>⚠️ ${escapeHtml(disclaimer.text)}</blockquote>`);
  }
  return lines;
}

/** "👥 Attendance Summary (27 players)" + the four effective counts (eligible roster; they add up). */
function attendanceLines(a: GameDayUpdateInput["attendance"]): string[] {
  const n = (v: unknown) => Math.max(0, Math.floor(finite(v) ? v : 0));
  const playing = n(a.playing);
  const notPlaying = n(a.notPlaying);
  const maybe = n(a.maybe);
  const noResponse = n(a.noResponse);
  const roster = playing + notPlaying + maybe + noResponse;
  return [
    `👥 Attendance Summary (${plural(roster, "player")})`,
    `✅ Playing: ${playing}`,
    `❌ Not Playing: ${notPlaying}`,
    `🤔 Maybe: ${maybe}`,
    `⏳ Not Responded: ${noResponse}`,
  ];
}

/** An authorized link from the caller, used only if it is an absolute https URL (never guessed or built here). */
function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function buildGameDayUpdate(input: GameDayUpdateInput): GameDayUpdateMessage {
  const { timezone: tz, match, deadline, now } = input;
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) return { ok: false, reason: "INVALID_INPUT" };
  if (match.startTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(match.startTime)) return { ok: false, reason: "INVALID_INPUT" };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const left = deadline.getTime() - now.getTime();
  if (left <= 0) return { ok: false, reason: "DEADLINE_PASSED" };

  let truncated = false;
  const track = (t: boolean) => void (truncated = truncated || t);
  const display = clean(input.displayName, CAP.name);
  const name = display.text ? display : clean(input.groupName, CAP.name);
  track(name.truncated);
  const venue = clean(match.venueName, CAP.venue);
  track(venue.truncated);

  const lines = [
    `<b>⚽ Game Day Update — ${escapeHtml(name.text || "Your group")}</b>`,
    "",
    `📅 ${kickoffLine(match.date, match.startTime, tz)}`,
    ...(venue.text ? [`📍 ${escapeHtml(venue.text)}`] : []),
    ...weatherLines(input.weather, input.units, Boolean(match.isIndoor), track),
    "",
    ...attendanceLines(input.attendance),
    "",
    // M12B — an absolute time (a relative "closes in 4 hours" goes stale in the chat).
    `⏰ Attendance closes ${deadlineText(deadline, now, tz)}.`,
    ...pollLines(input.poll),
  ];
  const html = lines.join("\n");
  // Every field is capped, so this can't happen — but never hand Telegram an over-long message.
  if (Array.from(html).length > TELEGRAM_TEXT_LIMIT) return { ok: false, reason: "INVALID_INPUT" };
  return { ok: true, html, parseMode: "HTML", disableWebPagePreview: true, truncated };
}
