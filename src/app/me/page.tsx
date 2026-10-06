import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Clock, MapPin, Medal, MessageCircle, Ticket, Trophy } from "lucide-react";
import { requireSessionAccount, TenantContextError } from "@/lib/tenantContext";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import { loadMyGames, type MyGamesProfile, type MyRecentGame, type MyUpcomingGame } from "@/lib/myGames";
import ConnectTelegram from "./ConnectTelegram";
import MyAttendance from "./MyAttendance";
import { cn } from "@/lib/cn";

/**
 * M6-C / UI-6 — "My Games": the signed-in User's player experience, built
 * ONLY from the Players they have claimed (src/lib/myGames.ts — player-facing
 * allow-list, published post-game data only, no ratings or stamina). Not an
 * organizer view. Taking part through Telegram never requires this page.
 */
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export const metadata = { title: "My Games — Team Balance Pro" };

export default async function MyGamesPage() {
  let account;
  try {
    account = await requireSessionAccount();
  } catch (e) {
    if (e instanceof TenantContextError) redirect("/login?callbackUrl=%2Fme");
    throw e;
  }
  if (!account.emailVerified) {
    return (
      <EmptyState title="Verify your email" heading="h1">
        <p>Verify your email address to see your games.</p>
        <Link className={cn("mt-4 inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground", focusRing)} href="/verify-email?next=%2Fme">
          Verify email
        </Link>
      </EmptyState>
    );
  }

  const profiles = await loadMyGames(account.id);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="eyebrow">Player</p>
        <h1 className="mt-1 text-3xl font-extrabold">My Games</h1>
        {profiles.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {profiles.length === 1 ? `Playing as ${profiles[0].displayName}` : `${profiles.length} player profiles connected to your account`}
          </p>
        )}
      </header>

      {profiles.length === 0 ? (
        <EmptyState title="No player profile connected">
          <p>Your account isn&apos;t connected to a player in any group yet, so there are no games to show.</p>
          <p className="mt-2">Ask your organizer for a player claim link and open it while signed in. You can still answer attendance polls in Telegram without one.</p>
        </EmptyState>
      ) : (
        profiles.map((p) => <Profile key={p.playerId} p={p} single={profiles.length === 1} />)
      )}
    </div>
  );
}

function EmptyState({ title, children, heading = "h2" }: { title: string; children: React.ReactNode; heading?: "h1" | "h2" }) {
  const H = heading;
  return (
    <section className="mx-auto max-w-lg rounded-tbp-2xl border border-dashed border-border bg-card p-8 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-secondary text-primary" aria-hidden="true">
        <Ticket className="size-6" />
      </span>
      <H className="mt-4 text-xl font-extrabold">{title}</H>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function Meta({ date, startTime, locationName, onDark = false, hideDate = false }: { date: string; startTime: string | null; locationName: string | null; onDark?: boolean; hideDate?: boolean }) {
  const time = formatStartTime(startTime);
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1 text-sm", onDark ? "opacity-85" : "text-muted-foreground")}>
      {!hideDate && (
        <li className="flex items-center gap-1.5">
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          {formatLongDateOnly(date)}
        </li>
      )}
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

function Profile({ p, single }: { p: MyGamesProfile; single: boolean }) {
  const [next, ...later] = p.upcoming;
  const headingId = `profile-${p.playerId}`;
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="eyebrow truncate">{p.organizationName}</p>
          <h2 id={headingId} className="break-words text-xl font-extrabold">
            {p.groupName} <span className="text-base font-semibold text-muted-foreground">· {p.sportLabel}</span>
          </h2>
          {!single && <p className="text-sm text-muted-foreground">Playing as {p.displayName}</p>}
        </div>
      </div>

      {next ? <NextGame g={next} /> : <p className="rounded-tbp-xl border border-dashed border-border bg-card p-5 text-sm text-muted-foreground">No upcoming games scheduled in this group yet.</p>}

      {later.length > 0 && (
        <div className="rounded-tbp-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Also coming up</h3>
          <ul className="mt-2 space-y-1.5">
            {later.map((g) => (
              <li key={g.matchId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Meta date={g.date} startTime={g.startTime} locationName={g.locationName} />
                <Link href={g.matchHref} className={cn("font-semibold text-primary hover:underline", focusRing)}>
                  View<span className="sr-only"> match on {formatLongDateOnly(g.date)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-lg font-extrabold">Recent games</h3>
        {p.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No past games with you on a published team yet.</p>
        ) : (
          <ul className="space-y-3">
            {p.recent.map((g) => (
              <RecentGame key={g.matchId} g={g} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-tbp-xl border border-border bg-card p-4 text-sm">
        <MessageCircle className="size-5 shrink-0 text-primary" aria-hidden="true" />
        <span className="font-semibold">Telegram: {p.telegramConnected ? "connected" : "not connected"}</span>
        <ConnectTelegram playerId={p.playerId} connected={p.telegramConnected} />
      </div>
    </section>
  );
}

function NextGame({ g }: { g: MyUpcomingGame }) {
  return (
    <article aria-label="Your next game" className="overflow-hidden rounded-tbp-2xl border border-border bg-card shadow-card">
      <div className="pitch-lines bg-pitch p-5 text-pitch-foreground">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Next game</p>
        <p className="mt-2 font-display text-2xl font-black">{formatLongDateOnly(g.date)}</p>
        <div className="mt-1">
          <Meta date={g.date} startTime={g.startTime} locationName={g.locationName} onDark hideDate />
        </div>
      </div>
      <div className="space-y-4 p-5">
        <div>
          <h4 className="mb-2 font-semibold">Are you playing?</h4>
          <MyAttendance matchId={g.matchId} status={g.myStatus} byOrganizer={g.myStatusByOrganizer} closed={g.attendanceClosed} />
        </div>
        <div className="border-t border-border pt-4 text-sm">
          {g.myTeam ? (
            <p>
              <span className="font-semibold">Your team: Team {g.myTeam.teamNumber}</span>
              {g.myTeam.teammates.length > 0 && <span className="text-muted-foreground"> — with {g.myTeam.teammates.join(", ")}</span>}
            </p>
          ) : (
            <p className="text-muted-foreground">{g.teamsPublished ? "You're not on the published teams for this game." : "Teams haven't been published yet."}</p>
          )}
        </div>
        <Link href={g.matchHref} className={cn("inline-flex min-h-11 items-center rounded-full border border-input px-5 text-sm font-semibold hover:bg-muted", focusRing)}>
          View match page
        </Link>
      </div>
    </article>
  );
}

function RecentGame({ g }: { g: MyRecentGame }) {
  // M8.1 — one game (two teams): the familiar score + my W/D/L. 3+ teams: my team's own
  // fixtures, each with its own W/D/L — never an invented overall result.
  const single = g.result && !g.result.legacyStandings && g.result.fixtures.length === 1 ? g.result.fixtures[0] : null;
  const OUTCOME = { W: "Win", D: "Draw", L: "Loss" } as const;
  return (
    <li className="rounded-tbp-xl border border-border bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Meta date={g.date} startTime={g.startTime} locationName={g.locationName} />
          <p className="mt-1 text-sm">
            <span className="font-semibold">Team {g.myTeam.teamNumber}</span>
            {g.myTeam.teammates.length > 0 && <span className="text-muted-foreground"> — with {g.myTeam.teammates.join(", ")}</span>}
          </p>
        </div>
        {single ? (
          <div className="text-right">
            <p className="font-display text-xl font-black tabular-nums">
              {single.scoreA} – {single.scoreB}
              <span className="sr-only"> (Team {single.teamA} {single.scoreA}, Team {single.teamB} {single.scoreB})</span>
            </p>
            {g.myRecord[0] && <p className="text-xs font-bold uppercase tracking-wider text-primary">{OUTCOME[g.myRecord[0].outcome]}</p>}
          </div>
        ) : g.result && g.myRecord.length > 0 ? (
          <ul className="space-y-0.5 text-right text-sm" aria-label={`Team ${g.myTeam.teamNumber} fixtures`}>
            {g.myRecord.map((r) => (
              <li key={r.opponent} className="tabular-nums">
                <span className="text-muted-foreground">vs Team {r.opponent}</span>{" "}
                <span className="font-bold text-primary">
                  {r.outcome}
                  <span className="sr-only"> ({OUTCOME[r.outcome]})</span>
                </span>{" "}
                <span className="font-display font-black">
                  {r.scoreFor}–{r.scoreAgainst}
                </span>
              </li>
            ))}
          </ul>
        ) : g.result?.legacyStandings ? (
          <p className="text-right text-sm font-semibold tabular-nums">{g.result.legacyStandings.map((t) => `Team ${t.teamNumber} ${t.score}`).join(" · ")}</p>
        ) : (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">Result not published</span>
        )}
      </div>
      {(g.mvp || g.mvpVoteOpen || g.recap) && (
        <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
          {g.mvp && (
            <p className="flex items-center gap-2">
              <Medal className="size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>
                Player of the Match{g.mvp.shared ? "es" : ""}: <span className="font-semibold">{g.mvp.names.join(", ")}</span>
              </span>
            </p>
          )}
          {!g.mvp && g.mvpVoteOpen && (
            <p className="flex items-center gap-2">
              <Trophy className="size-4 shrink-0 text-primary" aria-hidden="true" />
              Player of the Match voting is open in your group&apos;s Telegram poll.
            </p>
          )}
          {g.recap && <p className="whitespace-pre-line text-muted-foreground">{g.recap.text}</p>}
        </div>
      )}
      <Link href={g.matchHref} className={cn("mt-3 inline-flex text-sm font-semibold text-primary hover:underline", focusRing)}>
        View match page<span className="sr-only"> for {formatLongDateOnly(g.date)}</span>
      </Link>
    </li>
  );
}
