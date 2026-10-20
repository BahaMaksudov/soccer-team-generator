"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Clock, MapPin } from "lucide-react";
import { Card, MatchPageShell } from "@/components/match-link/MatchView";
import { focusRing } from "@/components/game-day/parts";
import { cn } from "@/lib/cn";

/**
 * M12B — the player's own attendance page (personal link). Shows ONLY this
 * player's name and answer; the server decides who the player is (from the
 * link), never this page. The countdown runs on the server's clock (offset
 * measured on load), so a wrong device clock can't make it misleading.
 */
type Status = "PLAYING" | "MAYBE" | "NOT_PLAYING";
type State = "open" | "closed" | "canceled" | "revoked" | "telegram";
type View = {
  state: State;
  playerName: string;
  title: string;
  match: { date: string; kickoffLabel: string | null; timeZone: string; venue: string | null; address: string | null; deadline: string | null; deadlineLabel: string | null };
  current: { status: Status | null; setByOrganizer: boolean };
  serverNow: string;
};

const OPTIONS: Array<{ status: Status; label: string }> = [
  { status: "PLAYING", label: "Playing" },
  { status: "MAYBE", label: "Maybe" },
  { status: "NOT_PLAYING", label: "Not playing" },
];
const STATE_TEXT: Record<Exclude<State, "open">, { title: string; body: string }> = {
  closed: { title: "Responses are closed", body: "Attendance for this match is closed. Contact your organizer if your plans changed." },
  canceled: { title: "Match canceled", body: "This match was canceled." },
  revoked: { title: "This link was replaced", body: "Your organizer replaced or revoked this link. Ask them for your current link." },
  telegram: { title: "Vote in Telegram", body: "This match uses your group's Telegram poll for attendance — please vote there." },
};

/** "2 days 3 hours", "3 hours 20 minutes", "45 minutes" — always from the server's clock. */
export function timeLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    const d = Math.floor(hours / 24);
    const h = hours % 24;
    return h ? `${plural(d, "day")} ${plural(h, "hour")}` : plural(d, "day");
  }
  const rest = minutes % 60;
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

export default function PersonalAttendancePage() {
  const [token, setToken] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [offset, setOffset] = useState(0); // server time − device time
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const onHash = () => window.location.reload();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "");
    setToken(t);
    if (!t) return setError("This link is not valid.");
    (async () => {
      try {
        const res = await fetch("/api/attend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }), cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return setError(data?.error || "This link is not valid.");
        setView(data as View);
        setOffset(Date.parse((data as View).serverNow) - Date.now());
      } catch {
        setError("Could not load your match. Please try again.");
      }
    })();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const left = useMemo(() => (view?.match.deadline ? Date.parse(view.match.deadline) - (tick + offset) : null), [view, tick, offset]);
  const expired = left !== null && left <= 0;

  async function answer(status: Status) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/attend/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, status }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "warn", text: data?.error || "Your answer could not be saved." });
        if (["closed", "canceled", "revoked", "telegram"].includes(data?.code)) setView((v) => (v ? { ...v, state: data.code } : v));
        return;
      }
      setView((v) => (v ? { ...v, current: { status, setByOrganizer: data.setByOrganizer } } : v));
      setNotice({ tone: "ok", text: data.setByOrganizer ? "Saved. Your organizer has set your status for this match; they'll see your answer." : "Your answer was saved." });
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
        <h1 className="text-xl font-extrabold">Your attendance</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-2 text-sm text-muted-foreground">Ask your organizer for your current personal link.</p>
      </div>
    );
  if (!view) return shell(<p className="text-sm text-muted-foreground">Loading…</p>);

  const day = new Date(`${view.match.date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
  const state: State = view.state === "open" && expired ? "closed" : view.state;
  return shell(
    <>
      <header>
        <p className="text-xs font-bold uppercase tracking-widest text-accent">{view.title}</p>
        <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">Hi {view.playerName} — are you playing?</h1>
      </header>
      <Card title="Match" icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
        <p className="text-sm font-semibold">
          {day}
          {view.match.kickoffLabel ? ` · ${view.match.kickoffLabel}` : ""}
        </p>
        {view.match.venue && (
          <p className="mt-2 flex items-start gap-2 text-sm">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {view.match.venue}
              {view.match.address ? <span className="block text-muted-foreground">{view.match.address}</span> : null}
            </span>
          </p>
        )}
        {view.match.deadlineLabel && (
          <p className="mt-2 flex items-start gap-2 text-sm">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 break-words">
              Responses close {view.match.deadlineLabel}
              {state === "open" && left !== null && left > 0 ? <span className="text-muted-foreground"> · in {timeLeft(left)}</span> : null}
            </span>
          </p>
        )}
      </Card>
      {state === "open" ? (
        <Card id="answer" title="Your answer" icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Your answer">
            {OPTIONS.map((o) => {
              const current = view.current.status === o.status;
              return (
                <button
                  key={o.status}
                  type="button"
                  disabled={busy}
                  aria-pressed={current}
                  onClick={() => answer(o.status)}
                  className={cn("min-h-12 rounded-tbp-md border px-1 text-sm font-bold transition-colors disabled:opacity-50", current ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted", focusRing)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {view.current.status ? `Saved: ${OPTIONS.find((o) => o.status === view.current.status)!.label}. You can change it until responses close.` : "You haven't answered yet."}
            {view.current.setByOrganizer ? " Your organizer has set your status for this match." : ""}
          </p>
          {notice && (
            <p role="status" className={cn("mt-3 text-sm font-semibold", notice.tone === "ok" ? "text-primary" : "text-destructive")}>
              {notice.text}
            </p>
          )}
        </Card>
      ) : (
        <Card id="answer" title={STATE_TEXT[state].title} icon={<CalendarDays className="size-5 text-primary" aria-hidden="true" />}>
          <p className="text-sm text-muted-foreground">{STATE_TEXT[state].body}</p>
          {view.current.status && <p className="mt-2 text-sm">Your answer: <span className="font-semibold">{OPTIONS.find((o) => o.status === view.current.status)!.label}</span></p>}
        </Card>
      )}
      <p className="text-center text-xs text-muted-foreground">This link is personal — don&apos;t share it. It only lets you answer for yourself.</p>
    </>
  );
}
