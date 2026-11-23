"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dices } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";

/**
 * Random Player Spotlight (Match workspace, OWNER/ADMIN). One explicit "Select Random Player"
 * action per Match; the server draws fairly (src/lib/spotlight.ts) and saves the result, so
 * reloads, regenerating teams, publishing and Telegram retries never pick someone else. The
 * optional text is saved with the selection and shown under the name in the Telegram teams post.
 */
type View = {
  pick: { playerId: string; playerName: string; note: string | null; cycle: number; selectedAt: string } | null;
  stillAttending: boolean;
  confirmedCount: number;
  poolSize: number;
  progress: { cycle: number; selected: number; roster: number; complete: boolean };
};
const NOTE_MAX = 200;

export default function SpotlightCard({ organizationSlug, groupSlug, matchId, onChanged }: { organizationSlug: string; groupSlug: string; matchId: string; onChanged?: () => void }) {
  const api = useMemo(() => adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}/spotlight` }), [organizationSlug, groupSlug, matchId]);
  const [view, setView] = useState<View | null>(null);
  const [note, setNote] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error" | "ok"; text: string } | null>(null);

  const apply = useCallback((v: View) => {
    setView(v);
    setNote(v.pick?.note ?? "");
    setSavedNote(v.pick?.note ?? "");
  }, []);

  useEffect(() => {
    fetch(api, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => v && apply(v))
      .catch(() => {});
  }, [api, apply]);

  async function send(method: "POST" | "PATCH", body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(api, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        apply(d);
        onChanged?.();
        return d;
      }
      if (d?.view) apply(d.view);
      setMessage({ tone: d?.code === "ALL_ATTENDEES_SELECTED" ? "info" : "error", text: d?.error ?? "Something went wrong." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    const d = await send("PATCH", { note });
    if (d) setMessage({ tone: "ok", text: note.trim() ? "Text saved." : "Text removed." });
  }

  const pick = view?.pick ?? null;
  const progress = view?.progress;
  const preview = pick ? ["\u{1F3B2} Random Player Spotlight", `Selected: ${pick.playerName}`, ...(savedNote.trim() ? [savedNote.trim()] : [])].join("\n") : null;
  const noteChars = [...note].length;

  return (
    <section aria-labelledby="spotlight-title" className="mt-4 space-y-3 rounded-tbp-xl border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="spotlight-title" className="flex items-center gap-2 font-display font-extrabold">
            <Dices className="size-5 text-primary" aria-hidden="true" /> Random Player Spotlight
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">One confirmed player, chosen at random. Everyone in the group gets a turn before anyone is picked again.</p>
        </div>
        {progress && (
          <p className="text-xs font-semibold text-muted-foreground" aria-live="polite">
            Cycle {progress.cycle} · {progress.selected} of {progress.roster} members have had a turn
            {progress.complete ? " · complete (the next pick starts a new cycle)" : ""}
          </p>
        )}
      </div>

      {!pick && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex min-h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || !view || view.confirmedCount === 0}
            onClick={() => send("POST", { action: "select" })}
          >
            {busy ? "Selecting…" : "Select Random Player"}
          </button>
          {view && view.confirmedCount === 0 && <span className="text-xs text-muted-foreground">Available once players are confirmed as playing.</span>}
          {view && view.confirmedCount > 0 && <span className="text-xs text-muted-foreground">{view.poolSize} of {view.confirmedCount} confirmed players can be picked this time.</span>}
        </div>
      )}

      {pick && (
        <div className="space-y-3">
          <p className="text-base">
            Selected: <b>{pick.playerName}</b>
          </p>
          {!view?.stillAttending && (
            <div role="alert" className="space-y-2 rounded-tbp-sm border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
              <p>{pick.playerName} is no longer marked as playing in this match.</p>
              <button
                type="button"
                className="inline-flex min-h-10 items-center rounded-full border border-input bg-card px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
                onClick={() => send("POST", { action: "replace" })}
              >
                Replace with another playing member
              </button>
              <p className="text-xs text-muted-foreground">
                Replacing never uses up a second turn: if {pick.playerName} was picked in the current cycle, they get their turn back.
              </p>
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor={`spotlight-note-${matchId}`} className="text-xs font-semibold">
              Message for {pick.playerName} (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={`spotlight-note-${matchId}`}
                className="h-10 min-w-0 flex-1 rounded-tbp-sm border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                value={note}
                maxLength={NOTE_MAX * 2}
                placeholder="e.g. Bring the match ball! ⚽"
                onChange={(e) => setNote(e.target.value)}
                aria-describedby={`spotlight-note-count-${matchId}`}
              />
              <button
                type="button"
                className="inline-flex min-h-10 items-center rounded-full border border-input bg-card px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy || note === savedNote || noteChars > NOTE_MAX}
                onClick={saveNote}
              >
                Save text
              </button>
            </div>
            <p id={`spotlight-note-count-${matchId}`} className={`text-xs ${noteChars > NOTE_MAX ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
              {noteChars}/{NOTE_MAX}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold">Added to the end of the Telegram teams post:</p>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded-tbp-sm bg-muted px-3 py-2 font-body text-sm">{preview}</pre>
          </div>
        </div>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-destructive" : message.tone === "ok" ? "text-primary" : "rounded-tbp-sm border border-accent/40 bg-accent/10 px-3 py-2"}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}
