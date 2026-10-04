import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, CalendarPlus, CircleCheck, Clock, MapPin, Shuffle, Users } from "lucide-react";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import { loadCanonicalAdminContext } from "./data";
import CanonicalAdminWorkspace from "./CanonicalAdminWorkspace";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import { loadGroupOverview, type GroupOverview } from "@/lib/groupOverview";
import { adminMatchesPath } from "@/lib/matchPaths";
import { ROLE_LABELS } from "@/lib/appShell";
import { ActionLink, focusRing, LifecycleSteps, PhasePill, SectionCard } from "@/components/game-day/parts";
import { MatchList } from "@/components/game-day/MatchList";
import { cn } from "@/lib/cn";

/**
 * Phase 2D.6C — canonical tenant Admin entry point; UI-4 — redesigned as the
 * organizer Overview ("what needs to happen next?") from REAL data only
 * (src/lib/groupOverview.ts), followed by the existing Players / Generate /
 * Settings / Visibility / Telegram sections, unchanged and still tenant-bound
 * to the canonical API via CanonicalAdminWorkspace.
 *
 * Organization/Group names displayed, and the slugs passed down, come from
 * the resolved TenantContext — never echoed directly from the raw URL params.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function CanonicalAdminHome({ params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const context = await loadCanonicalAdminContext({ organizationSlug, groupSlug });
  if (!context) notFound();
  // M7 — the Group's sport drives roles, labels, rules and settings. An
  // unknown key (never written by the app) renders with neutral labels;
  // every write and Generate fails closed server-side.
  const sport = findSport(context.activeGroup.sportKey);
  const overview = await loadGroupOverview(context);
  const matchesHref = adminMatchesPath(context.organization.slug, context.activeGroup.slug);
  const hasMatches = overview.upcoming.length + overview.past.length > 0;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow truncate">{context.organization.name}</p>
          <h1 className="mt-1 truncate text-3xl font-extrabold">{context.activeGroup.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {sport?.label ?? context.activeGroup.sportKey} · Your role: {ROLE_LABELS[context.membership.role]}
          </p>
        </div>
        <ActionLink href={`${matchesHref}#new`} variant="outline">
          New match
        </ActionLink>
      </header>
      {!sport && (
        <p className="rounded-tbp border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          This group&apos;s sport is not supported, so players and teams can&apos;t be changed.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-6">
          {overview.focus ? <FocusMatch focus={overview.focus} /> : <NoNextMatch hasMatches={hasMatches} matchesHref={matchesHref} />}
          {hasMatches && <NeedsAttention items={overview.attention} />}
          {overview.past.length > 0 && (
            <SectionCard
              title="Recent matches"
              action={
                <Link href={matchesHref} className={cn("text-sm font-semibold text-primary hover:underline", focusRing)}>
                  View all matches
                </Link>
              }
            >
              <MatchList matches={overview.past.slice(0, 5)} emptyText="No past matches yet." />
            </SectionCard>
          )}
        </div>
        <aside className="space-y-6" aria-label="Group summary">
          <SectionCard title="Group">
            <dl className="grid grid-cols-3 gap-2 text-center lg:grid-cols-1 lg:text-left">
              <Stat label="Active players" value={overview.activePlayers} />
              <Stat label="Upcoming matches" value={overview.upcoming.length} />
              <Stat label="Past matches" value={overview.past.length} />
            </dl>
            <div className="mt-4 flex flex-col gap-2">
              <Link href="#players" className={cn("inline-flex min-h-10 items-center gap-2 rounded-tbp-sm px-2 text-sm font-semibold text-primary hover:bg-muted", focusRing)}>
                <Users className="size-4" aria-hidden="true" /> Players
              </Link>
              <Link href={matchesHref} className={cn("inline-flex min-h-10 items-center gap-2 rounded-tbp-sm px-2 text-sm font-semibold text-primary hover:bg-muted", focusRing)}>
                <CalendarPlus className="size-4" aria-hidden="true" /> All matches
              </Link>
            </div>
          </SectionCard>
        </aside>
      </div>

      <section aria-labelledby="group-management" className="space-y-2 border-t border-border pt-8">
        <h2 id="group-management" className="text-xl font-extrabold">
          Players &amp; group settings
        </h2>
        <p className="text-sm text-muted-foreground">Manage the roster, sharing, Telegram and group settings. Match-day teams are built inside each match.</p>
        <CanonicalAdminWorkspace
          organizationSlug={context.organization.slug}
          groupSlug={context.activeGroup.slug}
          sport={sportClientView(sport ?? other)}
          canManage={context.membership.role === "OWNER" || context.membership.role === "ADMIN"}
        />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-tbp bg-muted px-3 py-2">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="font-display text-2xl font-black tabular-nums">{value}</dd>
    </div>
  );
}

function FocusMatch({ focus }: { focus: NonNullable<GroupOverview["focus"]> }) {
  const { match: m, counts, kind } = focus;
  const next = m.lifecycle.next;
  const time = formatStartTime(m.startTime);
  return (
    <section aria-labelledby="focus-match" className="pitch-lines overflow-hidden rounded-tbp-2xl bg-pitch text-pitch-foreground shadow-lift">
      <div className="space-y-3 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">{kind === "next" ? "Next match" : "Latest match"}</p>
          <PhasePill phase={m.lifecycle.phase} label={m.lifecycle.phaseLabel} onDark />
        </div>
        <h2 id="focus-match" className="text-2xl font-extrabold sm:text-3xl">
          {formatLongDateOnly(m.date)}
        </h2>
        {(time || m.locationName) && (
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm opacity-85">
            {time && (
              <li className="flex items-center gap-1.5">
                <Clock className="size-4" aria-hidden="true" />
                {time}
              </li>
            )}
            {m.locationName && (
              <li className="flex min-w-0 items-center gap-1.5">
                <MapPin className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{m.locationName}</span>
              </li>
            )}
          </ul>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-px bg-pitch-foreground/10 sm:grid-cols-3">
        <div className="bg-pitch px-5 py-4 sm:px-6">
          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider opacity-70">
            <Users className="size-4" aria-hidden="true" /> Attendance
          </dt>
          <dd className="mt-1.5">
            <span className="font-display text-2xl font-black">{counts.PLAYING}</span> <span className="text-sm">playing</span>
            <span className="mt-0.5 block text-xs opacity-75">
              {counts.MAYBE} maybe · {counts.NOT_PLAYING} not playing · {counts.NO_RESPONSE} no response
              {m.attendanceClosed ? " · closed" : ""}
            </span>
          </dd>
        </div>
        <div className="bg-pitch px-5 py-4 sm:px-6">
          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider opacity-70">
            <Shuffle className="size-4" aria-hidden="true" /> Teams
          </dt>
          <dd className="mt-1.5 font-semibold">{m.teamsPublished ? "Published" : "Not published yet"}</dd>
        </div>
        <div className="bg-pitch px-5 py-4 sm:px-6">
          <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider opacity-70">
            <CircleCheck className="size-4" aria-hidden="true" /> Result
          </dt>
          <dd className="mt-1.5 font-semibold">{m.publishedScores ? m.publishedScores.map((s) => s.score).join(" – ") : m.resultSaved ? "Saved, not published" : m.upcoming ? "After the game" : "Not entered"}</dd>
        </div>
      </dl>
      <div className="space-y-4 p-5 sm:p-6">
        <LifecycleSteps lifecycle={m.lifecycle} linkBase={m.href} onDark />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm opacity-80">{next ? `Next step: ${next.label}.` : m.lifecycle.phase === "complete" ? "Post-game is complete." : "Open the match for details."}</p>
          {next ? (
            <ActionLink href={`${m.href}${next.anchor}`} variant="accent">
              {next.label}
            </ActionLink>
          ) : (
            <ActionLink href={m.href} variant="onPitch">
              Open match
            </ActionLink>
          )}
        </div>
      </div>
    </section>
  );
}

function NoNextMatch({ hasMatches, matchesHref }: { hasMatches: boolean; matchesHref: string }) {
  return (
    <section aria-labelledby="no-next" className="rounded-tbp-2xl border border-dashed border-border bg-card p-6 text-center sm:p-8">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-secondary text-primary" aria-hidden="true">
        <CalendarPlus className="size-6" />
      </span>
      <h2 id="no-next" className="mt-4 text-xl font-extrabold">
        {hasMatches ? "No upcoming match" : "Plan your first match"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {hasMatches
          ? "Create the next match to collect attendance and build balanced teams."
          : "Create a match with a date (time and location are optional). Then collect attendance, generate balanced teams and record the result."}
      </p>
      <ActionLink href={`${matchesHref}#new`} className="mt-5">
        Create match
      </ActionLink>
    </section>
  );
}

function NeedsAttention({ items }: { items: GroupOverview["attention"] }) {
  return (
    <SectionCard title="Needs attention">
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-5 text-primary" aria-hidden="true" /> You&apos;re all caught up.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.matchId} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <AlertCircle className="size-5 shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{i.label}</span>
                <span className="text-muted-foreground"> · match on {formatLongDateOnly(i.date)}</span>
              </span>
              <Link href={i.href} className={cn("inline-flex min-h-10 items-center rounded-tbp-sm px-2 text-sm font-semibold text-primary hover:bg-muted", focusRing)}>
                Open<span className="sr-only"> match on {formatLongDateOnly(i.date)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

