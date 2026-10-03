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
  "You write a very short, friendly, energetic recap of a casual pickup sports game for the players' group chat.",
  "Use ONLY the facts in the JSON you are given. They are complete and verified.",
  "Do NOT invent anything: no events, goals, points, assists, saves, plays, turning points, comebacks, dominance, weather, injuries, quotes, statistics or player performances.",
  "Never change or reinterpret the score, the winner/draw or the Player of the Match. If there is no Player of the Match, do not name one.",
  "Do not mention skill levels or ratings. No insults, no teasing of any player or team, no remarks about personal or sensitive traits.",
  "Style: 2–4 short sentences, plain text (no markdown, no hashtags), at most two emojis.",
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

export type RecapFailCode = AiErrorCode | "TOO_LONG" | "INCONSISTENT";
export type AiRecapResult = { ok: true; text: string } | { ok: false; code: RecapFailCode; message: string };

const FAILURE_MESSAGE: Record<RecapFailCode, string> = {
  NOT_CONFIGURED: "AI recaps are not set up. Use the standard recap instead.",
  TIMEOUT: "The AI took too long. Try again, or use the standard recap.",
  RATE_LIMITED: "The AI service is busy right now. Try again shortly, or use the standard recap.",
  PROVIDER_ERROR: "The AI service had a problem. Try again, or use the standard recap.",
  EMPTY: "The AI returned nothing usable. Try again, or use the standard recap.",
  INVALID: "The AI returned nothing usable. Try again, or use the standard recap.",
  TOO_LONG: "The AI recap was too long. Try again, or use the standard recap.",
  INCONSISTENT: "The AI recap did not match the result. Try again, or use the standard recap.",
};

/** AI recap from verified facts. Never throws; the caller keeps the deterministic recap as fallback. */
export async function generateAiRecap(facts: RecapFacts, complete: ChatCompleter = openAiCompleter()): Promise<AiRecapResult> {
  const fail = (code: RecapFailCode): AiRecapResult => ({ ok: false, code, message: FAILURE_MESSAGE[code] });
  let raw: string;
  try {
    raw = await complete({ system: RECAP_SYSTEM_PROMPT, user: JSON.stringify(facts), maxTokens: 300 });
  } catch (e) {
    return fail(e instanceof AiError ? e.code : "PROVIDER_ERROR");
  }
  const text = sanitizeRecapText(raw);
  if (!text) return fail("EMPTY");
  if (text.length > RECAP_MAX_LENGTH) return fail("TOO_LONG");
  if (contradictsFacts(text, facts)) return fail("INCONSISTENT");
  return { ok: true, text };
}
