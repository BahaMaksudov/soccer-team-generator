import Link from "next/link";
import { ArrowRight, CalendarDays, CircleCheck, CircleDashed, CircleDot, Clock, MapPin } from "lucide-react";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { Lifecycle, Phase, Stage } from "@/lib/matchLifecycle";
import { cn } from "@/lib/cn";

/**
 * UI-4 — game-day presentation pieces (visual reference: the approved Lovable
 * Overview / Match Workspace). Server-safe and stateless; every value comes
 * from real Match data passed in by the caller. Status is always spelled out
 * in text (never color alone).
 */

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function MatchMeta({ date, startTime, locationName, onDark = false, className }: { date: string; startTime: string | null; locationName: string | null; onDark?: boolean; className?: string }) {
  const time = formatStartTime(startTime);
  return (
    <ul className={cn("flex flex-wrap gap-x-5 gap-y-1 text-sm", onDark ? "opacity-85" : "text-muted-foreground", className)}>
      <li className="flex items-center gap-1.5">
        <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
        {formatLongDateOnly(date)}
      </li>
      {time && (
        <li className="flex items-center gap-1.5">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {time}
        </li>
      )}
      {locationName && (
        <li className="flex min-w-0 items-center gap-1.5">
          <MapPin className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{locationName}</span>
        </li>
      )}
    </ul>
  );
}

const PHASE_TONE: Record<Phase, string> = {
  upcoming: "bg-secondary text-secondary-foreground",
  postgame: "bg-accent/20 text-accent-foreground",
  complete: "bg-primary/15 text-primary",
  canceled: "bg-muted text-muted-foreground line-through decoration-1",
};

export function PhasePill({ phase, label, onDark = false }: { phase: Phase; label: string; onDark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold", onDark ? "bg-pitch-foreground/15 text-pitch-foreground" : PHASE_TONE[phase])}>
      <span className={cn("size-1.5 rounded-full", phase === "complete" ? "bg-primary" : phase === "canceled" ? "bg-muted-foreground" : "bg-accent")} aria-hidden="true" />
      {label}
    </span>
  );
}

/** "Done" / "Next" / "To do" are always written out; icons are decorative. */
export function StageIcon({ state, className }: { state: Stage["state"]; className?: string }) {
  if (state === "done") return <CircleCheck className={cn("size-4 shrink-0 text-primary", className)} aria-hidden="true" />;
  if (state === "current") return <CircleDot className={cn("size-4 shrink-0 text-accent", className)} aria-hidden="true" />;
  return <CircleDashed className={cn("size-4 shrink-0 opacity-50", className)} aria-hidden="true" />;
}
const STATE_TEXT: Record<Stage["state"], string> = { done: "Done", current: "Next", todo: "To do" };

export function LifecycleSteps({ lifecycle, linkBase, onDark = false }: { lifecycle: Lifecycle; linkBase?: string; onDark?: boolean }) {
  return (
    <ol aria-label="Match progress" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {lifecycle.stages.map((s) => {
        const body = (
          <>
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider opacity-70">
              <StageIcon state={s.state} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="mt-1 block truncate text-sm font-semibold">
              <span className="sr-only">{STATE_TEXT[s.state]}: </span>
              {s.detail}
            </span>
          </>
        );
        const cls = cn(
          "block min-w-0 rounded-tbp px-3 py-2.5",
          onDark ? "bg-pitch-foreground/10" : "border border-border bg-card",
          s.state === "current" && (onDark ? "ring-2 ring-accent" : "border-accent ring-1 ring-accent")
        );
        return (
          <li key={s.key} aria-current={s.state === "current" ? "step" : undefined} className="min-w-0">
            {linkBase ? (
              <a href={`${linkBase}#${s.key}`} className={cn(cls, "hover:bg-muted/60", focusRing)}>
                {body}
              </a>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function SectionCard({
  id,
  title,
  icon,
  meta,
  action,
  children,
  className,
}: {
  id?: string;
  title: string;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("scroll-mt-20 rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && (
            <span className="grid size-9 shrink-0 place-items-center rounded-tbp-sm bg-secondary text-primary" aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 id={headingId} className="text-lg font-extrabold">
              {title}
            </h2>
            {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Text status chip (never color-only). */
export function StateChip({ tone, children }: { tone: "done" | "pending" | "neutral" | "warn"; children: React.ReactNode }) {
  const t = {
    done: "bg-primary/10 text-primary border-primary/20",
    pending: "bg-accent/15 text-accent-foreground border-accent/30",
    neutral: "bg-muted text-muted-foreground border-border",
    warn: "bg-destructive/10 text-destructive border-destructive/20",
  }[tone];
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold", t)}>{children}</span>;
}

export function ActionLink({ href, children, variant = "primary", className }: { href: string; children: React.ReactNode; variant?: "primary" | "accent" | "outline" | "onPitch"; className?: string }) {
  const v = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    accent: "bg-accent text-accent-foreground hover:brightness-105",
    outline: "border border-input bg-card text-foreground hover:bg-muted",
    onPitch: "border border-pitch-foreground/30 text-pitch-foreground hover:bg-pitch-foreground/10",
  }[variant];
  return (
    <Link href={href} className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold", v, focusRing, className)}>
      {children}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

export function ScoreLine({ scores }: { scores: Array<{ teamNumber: number; score: number }> }) {
  return (
    <span className="font-display text-base font-black tabular-nums">
      {scores.map((s, i) => (
        <span key={s.teamNumber}>
          {i > 0 && <span className="mx-1 font-normal text-muted-foreground">–</span>}
          <span className="sr-only">Team {s.teamNumber} </span>
          {s.score}
        </span>
      ))}
    </span>
  );
}

/** M8.1 — what any published result renders from (fixtures, or labeled pre-M8.1 per-team standings). */
export type ResultDisplay = {
  fixtures: Array<{ teamA: number; teamB: number; scoreA: number; scoreB: number; winner: number | null }>;
  legacyStandings: Array<{ teamNumber: number; score: number }> | null;
};

/**
 * Compact published result for lists: a two-team match keeps its familiar
 * "5 – 3"; 3+ teams show each fixture ("T1 5–3 T2"); a pre-M8.1 per-team row
 * shows labeled team scores — never a misleading "5 – 3 – 2".
 */
export function ResultSummary({ result }: { result: ResultDisplay }) {
  if (result.legacyStandings) {
    return (
      <span className="text-sm font-semibold tabular-nums">
        {result.legacyStandings.map((t, i) => (
          <span key={t.teamNumber}>
            {i > 0 && <span className="mx-1 font-normal text-muted-foreground">·</span>}T{t.teamNumber} {t.score}
          </span>
        ))}
      </span>
    );
  }
  if (result.fixtures.length === 1) {
    const f = result.fixtures[0];
    return <ScoreLine scores={[{ teamNumber: f.teamA, score: f.scoreA }, { teamNumber: f.teamB, score: f.scoreB }]} />;
  }
  return (
    <ul className="space-y-0.5 text-sm font-semibold tabular-nums" aria-label="Fixture results">
      {result.fixtures.map((f) => (
        <li key={`${f.teamA}-${f.teamB}`} className="whitespace-nowrap">
          <span className="sr-only">Team </span>T{f.teamA} {f.scoreA}–{f.scoreB} <span className="sr-only">Team </span>T{f.teamB}
        </li>
      ))}
    </ul>
  );
}

/**
 * Full published result (match pages): one row per fixture, "Team 1 vs Team 2"
 * with both scores and the fixture's winner or draw. `highlightTeam` marks the
 * viewer's team (My Games) without inventing an overall result.
 */
export function FixtureResults({ result, highlightTeam }: { result: ResultDisplay; highlightTeam?: number | null }) {
  if (result.legacyStandings) {
    return (
      <div className="space-y-1 text-sm">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {result.legacyStandings.map((t) => (
            <li key={t.teamNumber} className={cn("tabular-nums", highlightTeam === t.teamNumber && "font-bold")}>
              Team {t.teamNumber}: <span className="font-semibold">{t.score}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">Recorded as one score per team (before fixture results).</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Fixture results">
      {result.fixtures.map((f) => (
        <li key={`${f.teamA}-${f.teamB}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-tbp border border-border bg-card px-3 py-2">
          <span className="flex items-center gap-2 font-semibold tabular-nums">
            <span className={cn(highlightTeam === f.teamA && "underline decoration-2 underline-offset-4")}>Team {f.teamA}</span>
            <span className="font-display text-lg font-black">
              {f.scoreA} <span className="font-normal text-muted-foreground">–</span> {f.scoreB}
            </span>
            <span className={cn(highlightTeam === f.teamB && "underline decoration-2 underline-offset-4")}>Team {f.teamB}</span>
          </span>
          <span className="text-xs font-semibold text-muted-foreground">{f.winner === null ? "Draw" : `Team ${f.winner} won`}</span>
        </li>
      ))}
    </ul>
  );
}
