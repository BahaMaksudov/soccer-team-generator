"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { focusRing } from "@/components/game-day/parts";
import { Card, MatchPageShell, MatchView } from "./MatchView";
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

  const shell = (children: React.ReactNode) => <MatchPageShell>{children}</MatchPageShell>;

  if (error)
    return shell(
      <div className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <h1 className="text-xl font-extrabold">Match</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-2 text-sm text-muted-foreground">Ask your organizer for the current match link.</p>
      </div>
    );
  if (!view) return shell(<p className="text-sm text-muted-foreground">Loading…</p>);

  const { group } = view;
  const link = view.link;
  const title = link?.communityName || group.teamName || group.name;

  return shell(
    <MatchView
      view={view}
      title={title}
      attendance={
        <>
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

        </>
      }
    />
  );
}
