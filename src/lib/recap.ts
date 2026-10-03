import { AiError, openAiCompleter, type AiErrorCode, type ChatCompleter } from "@/lib/ai/openai";

/**
 * M9-D — Match recap facts, deterministic recap and the AI language layer.
 *
 * The APPLICATION computes every fact (score, winner/draw, MVP); AI only
 * turns those verified facts into friendly prose. buildRecapFacts() picks an
 * explicit allow-list — nothing else (ids, emails, Telegram identity,
 * ratings, stamina, metrics, organizer data) can reach the AI payload.
 * Generated text is validated, never auto-saved as the canonical recap,
 * never published and never sent.
 */

export const RECAP_MAX_LENGTH = 1200;
/** Responses API max_output_tokens for one recap (reasoning + visible text). */
export const RECAP_MAX_OUTPUT_TOKENS = 1000;

export type RecapFacts = {
  sport: string;
  date: string; // YYYY-MM-DD
  venue: string | null;
  teams: Array<{ name: string; score: number }>;
  outcome: { kind: "WIN"; winner: string } | { kind: "DRAW" };
  scoreLine: string; // e.g. "7–5" (team order)
  mvp: string[]; // published Player-of-the-Match display name(s), possibly empty
  participants: number;
};

/** Accepts any (possibly over-rich) context and keeps ONLY the approved facts. */
export function buildRecapFacts(input: {
  sportLabel?: unknown;
  date?: unknown;
  locationName?: unknown;
  scores?: unknown;
  mvpNames?: unknown;
  participantCount?: unknown;
  [extra: string]: unknown;
}): RecapFacts | null {
  const scores = Array.isArray(input.scores) ? input.scores : [];
  const teams = scores
    .map((s) => s as { teamNumber?: unknown; score?: unknown })
    .filter((s) => Number.isInteger(s.teamNumber) && Number.isInteger(s.score))
    .sort((a, b) => (a.teamNumber as number) - (b.teamNumber as number))
    .map((s) => ({ name: `Team ${s.teamNumber as number}`, score: s.score as number }));
  if (teams.length < 2 || typeof input.date !== "string") return null;
  const top = Math.max(...teams.map((t) => t.score));
  const leaders = teams.filter((t) => t.score === top);
  return {
    sport: typeof input.sportLabel === "string" ? input.sportLabel : "",
    date: input.date,
    venue: typeof input.locationName === "string" && input.locationName.trim() ? input.locationName.trim() : null,
    teams,
    outcome: leaders.length === 1 ? { kind: "WIN", winner: leaders[0].name } : { kind: "DRAW" },
    scoreLine: teams.map((t) => t.score).join("–"),
    mvp: Array.isArray(input.mvpNames) ? input.mvpNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim()) : [],
    participants: Number.isInteger(input.participantCount) ? (input.participantCount as number) : 0,
  };
}

const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Facts only — no invented events or performances. */
export function deterministicRecap(f: RecapFacts): string {
  const lines: string[] = [];
  if (f.teams.length === 2) {
    const [a, b] = f.teams;
    if (f.outcome.kind === "DRAW") lines.push(`The match finished ${a.score}–${b.score}.`);
    else {
      const [w, l] = a.score > b.score ? [a, b] : [b, a];
      lines.push(`${w.name} beat ${l.name}, ${w.score}–${l.score}.`);
    }
  } else {
    lines.push(`Final: ${f.teams.map((t) => `${t.name} ${t.score}`).join(", ")}.`);
    lines.push(f.outcome.kind === "WIN" ? `${f.outcome.winner} took the win.` : "It finished level at the top.");
  }
  if (f.mvp.length === 1) lines.push(`Player of the Match: ${f.mvp[0]}.`);
  if (f.mvp.length > 1) lines.push(`Players of the Match: ${joinNames(f.mvp)}.`);
  lines.push("Thanks to everyone who played!");
  return lines.join(" ");
}

export const RECAP_SYSTEM_PROMPT = [
  "You are the match-day voice of Team Balance Pro: a friendly sports commentator writing the post-game recap for a group of players right after their weekly pickup game.",
  "",
  "PERSONALITY",
  "- Fun, energetic, playful and conversational, with light friendly banter — like a teammate posting in the group chat, not a press release.",
  "- Never corporate, robotic or database-like; never melodramatic, childish, sarcastic or insulting.",
  "- Celebrate the winners warmly and keep it kind for everyone else (e.g. bragging rights, \"until the rematch\", \"back to the drawing board\", \"plenty to talk about in the group chat\").",
  "",
  "FACTS — the JSON you receive is the ONLY source of truth",
  "- Use the exact score, the winner or draw (`outcome`), the team names and the venue/date/sport only as given. Never change or reinterpret any of them.",
  "- You may state simple arithmetic derived from the scores: the total (e.g. \"eight goals hit the scoreboard\") or the margin (e.g. \"a two-goal win\").",
  "- Use scoring words that fit the sport (goals for soccer, points for basketball, and so on); if unsure, say \"on the scoreboard\".",
  "- If `mvp` lists names, name them naturally as Player of the Match (e.g. \"Player of the Match honors go to …! 🏆\"). Never say why they won. If `mvp` is empty, do not mention an MVP or Player of the Match at all.",
  "- `participants` is the number of players; you may mention it.",
  "- For a draw (`outcome.kind` = DRAW): playful and neutral — nobody won; do not explain how it ended level.",
  "- There may be more than two teams; mention every team as given.",
  "",
  "NEVER INVENT (none of this is in the facts): goal scorers, assists, saves, tackles, cards, penalties, overtime or extra time, halftime scores, lead changes, comebacks, individual performances or specific plays, injuries, weather, crowd or player behavior, rivalries, previous results, records or streaks. Banter must never imply that any such event happened.",
  "",
  "STYLE",
  "- 2–4 short sentences, at most about 600 characters.",
  "- 1–3 fitting emojis; do not stack them.",
  "- Vary the opening, how the score is presented and the closing line, so recaps do not all read the same.",
  "- Plain text only: no heading (such as \"Match Recap:\"), no markdown, no hashtags, no lists, no JSON, no quotes around the text, no explanations or disclaimers.",
  "",
  "Return only the recap text.",
].join("\n");

/** Plain text, bounded; null when unusable. */
export function sanitizeRecapText(raw: string): string | null {
  const text = raw
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length === 0 ? null : text;
}

/** Light consistency guard: any "X–Y" score in the text must be the real score (either order for two teams). */
export function contradictsFacts(text: string, f: RecapFacts): boolean {
  const allowed = new Set([f.scoreLine, [...f.teams].reverse().map((t) => t.score).join("–")]);
  for (const m of text.matchAll(/\b(\d{1,3})\s*[–—-]\s*(\d{1,3})\b/g)) {
    if (!allowed.has(`${m[1]}–${m[2]}`)) return true;
  }
  return false;
}

/**
 * Events the facts can never contain (we collect none), so any mention is an
 * invention. Deliberately a short list of unambiguous phrases — not a parser.
 */
const UNSUPPORTED_EVENT = /\b(come-?backs?|came back|hat[- ]?tricks?|penalt(y|ies)|overtime|extra[- ]time|half[- ]?time|injur(y|ies|ed)|(red|yellow) cards?|assists?|own goals?|equali[sz](er|ed|ing)|saves|stoppage time|shoot-?out)\b/i;
const MVP_MENTION = /\b(MVPs?|players? of the match)\b/i;
const WIN_WORDS = "(won|wins|win|beat|beats|defeated|victory|triumph(ed)?|took (it|the win))";

/**
 * Light fact guard beyond the score check: no invented events; an MVP may be
 * mentioned only when published, and then by name; a draw is never a win and
 * the losing team (two-team match) is never described as winning.
 */
export function unsupportedClaims(text: string, f: RecapFacts): string | null {
  if (UNSUPPORTED_EVENT.test(text)) return "event";
  if (MVP_MENTION.test(text) && (f.mvp.length === 0 || !f.mvp.some((n) => text.toLowerCase().includes(n.toLowerCase())))) return "mvp";
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (f.outcome.kind === "DRAW") {
    for (const t of f.teams) if (new RegExp(`\\b${esc(t.name)}\\s+${WIN_WORDS}\\b`, "i").test(text)) return "outcome";
  } else if (f.teams.length === 2) {
    const winner = f.outcome.winner;
    const loser = f.teams.find((t) => t.name !== winner)!;
    if (new RegExp(`\\b${esc(loser.name)}\\s+${WIN_WORDS}\\b`, "i").test(text)) return "outcome";
  }
  return null;
}

export type RecapFailCode = AiErrorCode | "TOO_LONG" | "INCONSISTENT";
export type AiRecapResult = { ok: true; text: string } | { ok: false; code: RecapFailCode; message: string };

const FAILURE_MESSAGE: Record<RecapFailCode, string> = {
  NOT_CONFIGURED: "AI recaps are not set up. Use the standard recap instead.",
  TIMEOUT: "The AI took too long. Try again, or use the standard recap.",
  RATE_LIMITED: "The AI service is busy right now. Try again shortly, or use the standard recap.",
  PROVIDER_ERROR: "The AI service had a problem. Try again, or use the standard recap.",
  EMPTY: "The AI returned nothing usable. Try again, or use the standard recap.",
  INVALID: "The AI returned nothing usable. Try again, or use the standard recap.",
  INCOMPLETE: "The AI recap was cut off. Try again, or use the standard recap.",
  TOO_LONG: "The AI recap was too long. Try again, or use the standard recap.",
  INCONSISTENT: "The AI recap did not match the result. Try again, or use the standard recap.",
};

/** AI recap from verified facts. Never throws; the caller keeps the deterministic recap as fallback. */
export async function generateAiRecap(facts: RecapFacts, complete: ChatCompleter = openAiCompleter()): Promise<AiRecapResult> {
  const fail = (code: RecapFailCode): AiRecapResult => ({ ok: false, code, message: FAILURE_MESSAGE[code] });
  let raw: string;
  try {
    // max_output_tokens covers reasoning + text; the visible recap is still capped at RECAP_MAX_LENGTH characters.
    raw = await complete({ system: RECAP_SYSTEM_PROMPT, user: JSON.stringify(facts), maxTokens: RECAP_MAX_OUTPUT_TOKENS });
  } catch (e) {
    return fail(e instanceof AiError ? e.code : "PROVIDER_ERROR");
  }
  const text = sanitizeRecapText(raw);
  if (!text) return fail("EMPTY");
  if (text.length > RECAP_MAX_LENGTH) return fail("TOO_LONG");
  if (contradictsFacts(text, facts) || unsupportedClaims(text, facts)) return fail("INCONSISTENT");
  return { ok: true, text };
}
