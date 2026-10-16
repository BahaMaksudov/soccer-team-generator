import { Clock, MapPin, Trophy, Users } from "lucide-react";
import { Logo } from "@/components/marketing/parts";
import { FixtureResults, focusRing } from "@/components/game-day/parts";
import { formatStartTime } from "@/lib/messaging/content";
import { cn } from "@/lib/cn";
import type { PlayerMatchView } from "@/lib/matchPage";

/**
 * The redesigned player-facing Match view (M9.3), shared by the Match Link page
 * (/share/m/<id>#<token>, which adds its attendance section) and the public
 * Match page (/g/<org>/<group>/m/<id>, "View teams online"). Presentation only:
 * the server's allow-listed view (names and roles — never ids, ratings,
 * stamina or identities). No hooks: usable from server and client components.
 */
export function longDate(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export function Card({ title, icon, children, id }: { title: string; icon?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section aria-labelledby={id ? `${id}-h` : undefined} className="rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5">
      <h2 id={id ? `${id}-h` : undefined} className="mb-3 flex items-center gap-2 font-display text-lg font-extrabold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function MatchPageShell({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased [&_h1]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]">
      <header className="flex h-14 items-center border-b border-border px-4 sm:px-6">
        <Logo />
      </header>
      <main id="main" className="mx-auto w-full max-w-2xl space-y-4 px-4 py-5 sm:py-8">
        {children}
      </main>
      <footer className="space-y-1 px-4 pb-8 text-center text-xs text-muted-foreground">
        <p>Team Balance Pro · balanced teams for pickup sports</p>
        {footer}
      </footer>
    </div>
  );
}

/**
 * `title`: the eyebrow (Community / team / group name); `subtitle`: an optional
 * line under the date (e.g. the organization); `attendance`: the Match Link's
 * answer section, shown between the match card and the teams.
 */
export function MatchView({ view, title, subtitle, attendance }: { view: PlayerMatchView; title: string; subtitle?: string | null; attendance?: React.ReactNode }) {
  const { group, match } = view;
  const time = formatStartTime(match.startTime);
  const venueName = view.venue?.name ?? match.locationName;
  return (
    <>
      {/* 1–4: match, date/time, venue, map */}
      <section className="pitch-lines rounded-tbp-2xl bg-pitch p-5 text-pitch-foreground shadow-lift" aria-labelledby="match-h">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">{[title, group.sportLabel].filter(Boolean).join(" · ")}</p>
        <h1 id="match-h" className="mt-1 text-2xl font-black leading-tight sm:text-3xl">
          {longDate(match.date)}
        </h1>
        {subtitle && <p className="mt-1 text-sm font-semibold opacity-85">{subtitle}</p>}
        <ul className="mt-3 space-y-1.5 text-sm">
          {time && (
            <li className="flex items-center gap-2">
              <Clock className="size-4 shrink-0" aria-hidden="true" /> {time}
            </li>
          )}
          {venueName && (
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">
                <span className="font-semibold">{venueName}</span>
                {view.venue?.address && <span className="block opacity-80">{view.venue.address}</span>}
              </span>
            </li>
          )}
        </ul>
        {(match.status !== "SCHEDULED" || view.venue?.mapsUrl) && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {match.status === "CANCELED" && <p className="rounded-full bg-destructive px-3 py-1 text-xs font-bold text-white">This match was canceled</p>}
            {match.status === "COMPLETED" && <p className="rounded-full bg-pitch-foreground/15 px-3 py-1 text-xs font-bold">Match completed</p>}
            {view.venue?.mapsUrl && (
              <a
                href={view.venue.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn("inline-flex min-h-11 items-center gap-2 rounded-full border border-pitch-foreground/30 px-4 text-sm font-semibold hover:bg-pitch-foreground/10", focusRing)}
              >
                <MapPin className="size-4" aria-hidden="true" /> View map
              </a>
            )}
          </div>
        )}
      </section>

      {attendance}

      {/* 6: published teams */}
      {view.teamsPublished ? (
        <Card id="teams" title="Teams" icon={<Users className="size-5 text-primary" aria-hidden="true" />}>
          <div className="grid gap-3 sm:grid-cols-2">
            {view.teams.map((t) => (
              <div key={t.teamNumber} className="rounded-tbp-xl border border-border p-3">
                <h3 className="font-display font-extrabold">Team {t.teamNumber}</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {t.players.map((p, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-x-2">
                      <span className="font-medium">{p.name}</span>
                      {p.role && <span className="text-muted-foreground">{p.role}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        match.status !== "CANCELED" && <p className="px-1 text-sm text-muted-foreground">Teams will appear here once the organizer publishes them.</p>
      )}

      {/* 7: published result */}
      {view.result && (
        <Card id="result" title="Final result" icon={<Trophy className="size-5 text-primary" aria-hidden="true" />}>
          <FixtureResults result={view.result} />
        </Card>
      )}

      {/* 8: published Player of the Match */}
      {view.mvp && view.mvp.names.length > 0 && (
        <Card id="potm" title={view.mvp.shared ? "Players of the Match" : "Player of the Match"} icon={<Trophy className="size-5 text-accent" aria-hidden="true" />}>
          <p className="font-display text-xl font-black">{view.mvp.names.join(" & ")}</p>
        </Card>
      )}

      {/* 9: published recap */}
      {view.recap && (
        <Card id="recap" title="Match recap">
          <p className="whitespace-pre-line text-sm leading-relaxed">{view.recap.text}</p>
        </Card>
      )}
    </>
  );
}
