"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Clock, MapPin, Trophy, Users } from "lucide-react";
import { Logo } from "@/components/marketing/parts";
import { FixtureResults, focusRing } from "@/components/game-day/parts";
import { formatStartTime } from "@/lib/messaging/content";
import { cn } from "@/lib/cn";
import type { PlayerMatchView } from "@/lib/matchPage";

/**
 * M9.3 — the player-facing Match page behind the Match Link (and the M9-C
 * group share link): redesigned, mobile-first, no account needed.
 *
 * Sections appear only when there is something player-visible: match,
 * date/time, venue + map, attendance (Match Link only, while open), PUBLISHED
 * teams, result, Player of the Match and recap. Data is the server's
 * allow-listed view (no Player ids, ratings or identities).
 *
 * "Remember me" is a device convenience only: the last chosen roster
 * reference for this Match Link is kept in localStorage and re-checked by the
 * server on every load (a reset link or a roster change forgets it). It grants
 * nothing the link itself doesn't.
 */
type Status = "PLAYING" | "MAYBE" | "NOT_PLAYING";
type Link = { communityName: string | null; state: "open" | "closed" | "canceled"; roster: Array<{ ref: string; name: string }> };
type Me = { name: string; status: Status | null; setByOrganizer: boolean };
export type MatchLinkPayload = PlayerMatchView & { link?: Link; me?: Me | null };

const OPTIONS: Array<{ status: Status; label: string }> = [
  { status: "PLAYING", label: "Playing" },
  { status: "MAYBE", label: "Maybe" },
  { status: "NOT_PLAYING", label: "Not playing" },
];
const STATUS_TEXT: Record<Status, string> = { PLAYING: "playing", MAYBE: "a maybe", NOT_PLAYING: "not playing" };

const storageKey = (matchId: string) => `tbp:match-link:${matchId}`;
function readRef(matchId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(matchId));
  } catch {
    return null;
  }
}
function writeRef(matchId: string, ref: string | null) {
  try {
    if (ref) window.localStorage.setItem(storageKey(matchId), ref);
    else window.localStorage.removeItem(storageKey(matchId));
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

function longDate(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function Card({ title, icon, children, id }: { title: string; icon?: React.ReactNode; children: React.ReactNode; id?: string }) {
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

export default function MatchLinkPage({ matchId }: { matchId: string }) {
  const [token, setToken] = useState<string>("");
  const [view, setView] = useState<MatchLinkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [ref, setRef] = useState<string>("");
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // A different link pasted into the same tab only changes the fragment: start over with it.
  useEffect(() => {
    const onHash = () => window.location.reload();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "");
    setToken(t);
    if (!t) {
      setError("This link is not valid.");
      return;
    }
    const remembered = readRef(matchId);
    (async () => {
      try {
        const res = await fetch("/api/share/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: t, matchId, ...(remembered ? { playerRef: remembered } : {}) }),
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return setError(data?.error || "This link is not valid.");
        const payload = data as MatchLinkPayload;
        setView(payload);
        if (remembered && payload.me) {
          setMe(payload.me);
          setRef(remembered);
        } else if (remembered) writeRef(matchId, null); // reset link or roster change: forget it
      } catch {
        setError("Could not load the match. Please try again.");
      }
    })();
  }, [matchId]);

  async function answer(status: Status) {
    if (!ref) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/share/match/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, matchId, playerRef: ref, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "warn", text: data?.error || "Your answer could not be saved." });
        return;
      }
      writeRef(matchId, ref);
      setMe({ name: data.name, status: data.status, setByOrganizer: data.setByOrganizer });
      setChoosing(false);
      setNotice({
        tone: "ok",
        text: data.setByOrganizer ? `Saved. Your organizer has set your status for this match; they'll see your answer.` : `Thanks, ${data.name} — you're ${STATUS_TEXT[data.status as Status]}.`,
      });
    } catch {
      setNotice({ tone: "warn", text: "Your answer could not be saved. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased [&_h1]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]">
      <header className="flex h-14 items-center border-b border-border px-4 sm:px-6">
        <Logo />
      </header>
      <main id="main" className="mx-auto w-full max-w-2xl space-y-4 px-4 py-5 sm:py-8">
        {children}
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-muted-foreground">Team Balance Pro · balanced teams for pickup sports</footer>
    </div>
  );

  if (error)
    return shell(
      <div className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <h1 className="text-xl font-extrabold">Match</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-2 text-sm text-muted-foreground">Ask your organizer for the current match link.</p>
      </div>
    );
  if (!view) return shell(<p className="text-sm text-muted-foreground">Loading…</p>);

  const { group, match } = view;
  const time = formatStartTime(match.startTime);
  const link = view.link;
  const title = link?.communityName || group.teamName || group.name;
  const venueName = view.venue?.name ?? match.locationName;

  return shell(
    <>
      {/* 1–4: match, date/time, venue, map */}
      <section className="pitch-lines rounded-tbp-2xl bg-pitch p-5 text-pitch-foreground shadow-lift" aria-labelledby="match-h">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">{[title, group.sportLabel].filter(Boolean).join(" · ")}</p>
        <h1 id="match-h" className="mt-1 text-2xl font-black leading-tight sm:text-3xl">
          {longDate(match.date)}
        </h1>
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

      {/* 5: attendance (Match Link only) */}
      {link && link.state === "open" && (
        <Card id="attend" title="Are you playing?" icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
          {me && !choosing ? (
            <p className="mb-3 text-sm">
              Responding as <span className="font-semibold">{me.name}</span>
              {me.status && (
                <>
                  {" "}
                  · currently <span className="font-semibold">{OPTIONS.find((o) => o.status === me.status)?.label}</span>
                </>
              )}
              .{" "}
              <button
                type="button"
                className={cn("font-semibold text-primary underline", focusRing)}
                onClick={() => {
                  setChoosing(true);
                  setNotice(null);
                }}
              >
                Not you? Change player
              </button>
            </p>
          ) : (
            <label className="mb-3 block text-sm font-semibold" htmlFor="who">
              Who&apos;s responding?
              <select
                id="who"
                className="mt-1 h-12 w-full rounded-tbp-md border border-input bg-card px-3 text-base font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  setNotice(null);
                }}
              >
                <option value="">Choose your name…</option>
                {link.roster.map((p) => (
                  <option key={p.ref} value={p.ref}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Your answer">
            {OPTIONS.map((o) => {
              const current = Boolean(me && !choosing && me.status === o.status);
              return (
                <button
                  key={o.status}
                  type="button"
                  disabled={busy || !ref}
                  aria-pressed={current}
                  onClick={() => answer(o.status)}
                  className={cn(
                    "min-h-12 rounded-tbp-md border px-2 text-sm font-bold transition-colors disabled:opacity-50",
                    current ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted",
                    focusRing
                  )}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {!ref && <p className="mt-2 text-xs text-muted-foreground">Choose your name first.</p>}
          {notice && (
            <p role="status" className={cn("mt-3 text-sm font-semibold", notice.tone === "ok" ? "text-primary" : "text-destructive")}>
              {notice.text}
            </p>
          )}
        </Card>
      )}
      {link && link.state === "closed" && !view.teamsPublished && (
        <Card id="attend" title="Responses are closed" icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
          <p className="text-sm text-muted-foreground">The organizer is putting the teams together. Check back on this link for the teams.</p>
        </Card>
      )}

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
