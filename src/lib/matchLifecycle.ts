/**
 * UI-4 — game-day lifecycle PRESENTATION, derived only from real persisted
 * Match state. This is not a status machine: nothing is stored and nothing
 * here gates an action — the server (src/lib/matches.ts, src/lib/postGame.ts,
 * the publish/generate routes) stays authoritative for every operation.
 *
 * Facts used (all real columns / existing views):
 *   Match.status (SCHEDULED | COMPLETED | CANCELED), Match.date,
 *   Match.attendanceClosedAt, effective PLAYING count, a published
 *   TeamGeneration for the Match, MatchResult (saved / publishedAt),
 *   MatchMvp.publishedAt, MatchRecap (content / publishedAt) and — for
 *   OWNER/ADMIN only — the Match Summary delivery state.
 *
 * "Upcoming" is exactly listMatches()'s rule: SCHEDULED and dated today or
 * later (UTC date). Anything else is past; past, non-canceled Matches are
 * in post-game. There is deliberately no "mark complete" step: post-game
 * never depends on Match.status = COMPLETED.
 */

export type MatchStatusValue = "SCHEDULED" | "COMPLETED" | "CANCELED";
/** Match Summary delivery as the server reports it (null: not visible to this role, or no Telegram group chosen yet). */
export type SummaryState = "not_posted" | "posted" | "updated_available" | "failed" | "uncertain" | "sending" | null;

export type LifecycleInput = {
  status: MatchStatusValue;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD (UTC), the same "today" listMatches() uses */
  today: string;
  attendanceClosed: boolean;
  playing: number;
  teamsPublished: boolean;
  result: { saved: boolean; published: boolean };
  mvpPublished: boolean;
  recap: { saved: boolean; published: boolean };
  summary: SummaryState;
  /** OWNER/ADMIN (isManager). MEMBER is read-only: no suggested action (presentation; the server enforces access). */
  canManage: boolean;
};

export type StageKey = "attendance" | "teams" | "result" | "mvp" | "recap" | "summary";
export type StageState = "done" | "current" | "todo";
export type Stage = { key: StageKey; label: string; state: StageState; detail: string };
export type Phase = "canceled" | "upcoming" | "postgame" | "complete";
export type NextAction = { key: StageKey; label: string; anchor: `#${StageKey}` } | null;

export type Lifecycle = { phase: Phase; phaseLabel: string; stages: Stage[]; next: NextAction };

export function isUpcomingYmd(status: MatchStatusValue, date: string, today: string): boolean {
  return status === "SCHEDULED" && date >= today;
}

export const todayUtcYmd = (now: Date = new Date()) => now.toISOString().slice(0, 10);

const action = (key: StageKey, label: string): NextAction => ({ key, label, anchor: `#${key}` });

/** The workflow's pending step (a pointer to the section that holds the real control). */
function nextActionOf(i: LifecycleInput, upcoming: boolean): NextAction {
  if (i.status === "CANCELED") return null;
  if (!i.teamsPublished) return i.playing === 0 && !i.attendanceClosed ? action("attendance", "Manage attendance") : action("teams", "Generate teams");
  if (upcoming) return action("teams", "Review teams");
  if (!i.result.saved) return action("result", "Enter result");
  if (!i.result.published) return action("result", "Publish result");
  // Player of the Match is decided by an owner/admin (selection, or starting a vote).
  if (!i.mvpPublished && i.canManage) return action("mvp", "Decide Player of the Match");
  if (!i.recap.published) return action("recap", i.recap.saved ? "Publish recap" : "Write recap");
  if (i.canManage && i.summary !== "posted") {
    if (i.summary === "sending") return null;
    return action("summary", i.summary === "updated_available" ? "Post updated Match Summary" : "Post Match Summary");
  }
  return null;
}

export function matchLifecycle(i: LifecycleInput): Lifecycle {
  const upcoming = isUpcomingYmd(i.status, i.date, i.today);
  const summaryPosted = i.summary === "posted";
  const done: Record<StageKey, boolean> = {
    attendance: i.attendanceClosed || i.teamsPublished,
    teams: i.teamsPublished,
    result: i.result.published,
    mvp: i.mvpPublished,
    recap: i.recap.published,
    summary: summaryPosted,
  };
  const detail: Record<StageKey, string> = {
    attendance: i.attendanceClosed ? `Closed · ${i.playing} playing` : `Open · ${i.playing} playing`,
    teams: i.teamsPublished ? "Published" : "Not published",
    result: i.result.published ? "Published" : i.result.saved ? "Saved, not published" : "Not entered",
    mvp: i.mvpPublished ? "Published" : "Not published",
    recap: i.recap.published ? "Published" : i.recap.saved ? "Saved, not published" : "Not written",
    summary:
      i.summary === null
        ? i.canManage
          ? "Not posted"
          : "Owner/admin posts"
        : summaryPosted
          ? "Posted"
          : i.summary === "updated_available"
            ? "Changed since posted"
            : i.summary === "uncertain"
              ? "Delivery uncertain"
              : i.summary === "sending"
                ? "Posting…"
                : "Not posted",
  };
  const labels: Record<StageKey, string> = { attendance: "Attendance", teams: "Teams", result: "Result", mvp: "Player of the Match", recap: "Recap", summary: "Match Summary" };
  // The workflow's pending step (what an organizer would do next). UI-4A — only
  // OWNER/ADMIN get it as an action; MEMBER is read-only and gets no call to action.
  const pending = nextActionOf({ ...i, canManage: true, summary: i.canManage ? i.summary : "posted" }, upcoming);
  const next = i.canManage ? pending : null;
  const keys: StageKey[] = ["attendance", "teams", "result", "mvp", "recap", "summary"];
  const stages: Stage[] = keys.map((key) => ({
    key,
    label: labels[key],
    detail: detail[key],
    state: done[key] ? "done" : pending?.key === key ? "current" : "todo",
  }));

  const phase: Phase = i.status === "CANCELED" ? "canceled" : upcoming ? "upcoming" : pending === null && i.result.published ? "complete" : "postgame";
  const phaseLabel = { canceled: "Canceled", upcoming: "Upcoming", postgame: "Post-game", complete: "Post-game complete" }[phase];
  return { phase, phaseLabel, stages, next };
}
