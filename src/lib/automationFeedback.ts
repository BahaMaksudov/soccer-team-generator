/**
 * M9.2.1 — organizer-facing summary of a Run now: only what the automation
 * engine reports actually happened (never claims work when nothing was due),
 * organizer-safe problem messages, and that a paused schedule stays paused.
 */
export type RunResult = { ok: boolean; paused: boolean; created: number; pollsPosted: number; cutoffs: number; notified: number; issues: string[] };
export type Feedback = { tone: "done" | "warn"; text: string; details?: string[] };

export function runFeedback(r: RunResult): Feedback {
  const done = [r.created && "Match created", r.pollsPosted && "Attendance poll posted", r.cutoffs && "Attendance finalized", r.notified && "Organizers notified"].filter(Boolean) as string[];
  const stays = r.paused ? " Automation stays paused." : "";
  if (r.issues.length) return { tone: "warn", text: `Automation ran with problems.${done.length ? ` Done: ${done.join(", ")}.` : ""}${stays}`, details: r.issues };
  if (!done.length) return { tone: "done", text: `Automation checked successfully — nothing was due right now.${stays}` };
  return { tone: "done", text: `Automation checked successfully: ${done.join(", ")}.${stays}` };
}
