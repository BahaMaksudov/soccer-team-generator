"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Card, MatchPageShell, MatchView } from "./MatchView";
import type { PlayerMatchView } from "@/lib/matchPage";

/**
 * M9.3 — the player-facing Match page behind the Match Link (and the M9-C
 * group share link): redesigned, mobile-first, no account needed.
 *
 * Sections appear only when there is something player-visible: match,
 * date/time, venue + map, PUBLISHED teams, result, Player of the Match and
 * recap. Data is the server's allow-listed view (no Player ids, ratings or
 * identities).
 *
 * M12B — VIEW-ONLY for attendance: nobody can answer (for anyone) through this
 * shared link any more. While attendance is open the page says how players
 * answer: the group's Telegram poll, or their own personal attendance link.
 */
type Link = { communityName: string | null; state: "open" | "closed" | "canceled"; mode: "telegram" | "web" };
export type MatchLinkPayload = PlayerMatchView & { link?: Link };

// Previous versions remembered a roster choice per match; clear it (it grants nothing now).
const storageKey = (matchId: string) => `tbp:match-link:${matchId}`;

export default function MatchLinkPage({ matchId }: { matchId: string }) {
  const [view, setView] = useState<MatchLinkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different link pasted into the same tab only changes the fragment: start over with it.
  useEffect(() => {
    const onHash = () => window.location.reload();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.removeItem(storageKey(matchId));
    } catch {
      /* storage unavailable */
    }
    const t = window.location.hash.replace(/^#/, "");
    if (!t) {
      setError("This link is not valid.");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/share/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: t, matchId }),
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return setError(data?.error || "This link is not valid.");
        setView(data as MatchLinkPayload);
      } catch {
        setError("Could not load the match. Please try again.");
      }
    })();
  }, [matchId]);

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
          {link && link.state === "open" && (
            <Card id="attend" title="Are you playing?" icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
              <p className="text-sm">
                {link.mode === "telegram"
                  ? "Vote in your group's Telegram attendance poll — that's where your answer counts. You can change your vote there until attendance closes."
                  : "Use the personal attendance link your organizer sent you. Each player has their own link, so nobody can answer for someone else."}
              </p>
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
