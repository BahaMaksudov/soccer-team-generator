"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export const TELEGRAM_POLL_ONLY = "Attendance is managed through the Telegram poll. Please submit or update your response in Telegram.";

const OPTIONS = [
  { status: "PLAYING", label: "Playing" },
  { status: "MAYBE", label: "Maybe" },
  { status: "NOT_PLAYING", label: "Not playing" },
] as const;

/** M9-A — the claimed player's own attendance for the next Match (source WEB). */
export default function MyAttendance({
  matchId,
  status,
  byOrganizer,
  closed = false,
  telegram = false,
}: {
  matchId: string;
  status: "PLAYING" | "NOT_PLAYING" | "MAYBE" | null;
  byOrganizer: boolean;
  /** UI-4B — closed attendance is read-only (the server rejects changes too). */
  closed?: boolean;
  /** M13A — a Telegram match: answered in the Telegram poll only (the server rejects website answers too). */
  telegram?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pollOnly, setPollOnly] = useState(telegram);

  async function choose(next: (typeof OPTIONS)[number]["status"]) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/account/matches/${encodeURIComponent(matchId)}/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) router.refresh();
      else {
        const code = res.status === 409 ? ((await res.json().catch(() => null)) as { code?: string } | null)?.code : undefined;
        if (code === "TELEGRAM_MATCH") {
          // This page was stale: a Telegram poll now runs this match.
          setPollOnly(true);
          router.refresh();
        } else setErr(res.status === 409 ? "Attendance is closed. Your organizer can reopen it." : "Could not save your answer.");
      }
    } catch {
      setErr("Could not save your answer.");
    }
    setBusy(false);
  }

  if (pollOnly) {
    const label = OPTIONS.find((o) => o.status === status)?.label;
    return (
      <div className="space-y-1">
        <p className="text-sm">{TELEGRAM_POLL_ONLY}</p>
        {label && (
          <div className="text-xs text-muted-foreground">
            Current answer: <span className="font-medium">{label}</span>
          </div>
        )}
      </div>
    );
  }

  if (closed) {
    const label = OPTIONS.find((o) => o.status === status)?.label ?? "No answer";
    return (
      <div className="space-y-1">
        <div className="text-sm">
          Your answer: <span className="font-medium">{label}</span>
        </div>
        <div className="text-xs text-muted-foreground">Attendance is closed. Your organizer can reopen it.</div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.status}
            type="button"
            disabled={busy}
            onClick={() => choose(o.status)}
            aria-pressed={status === o.status}
            className={`min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${status === o.status ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {byOrganizer && <div className="text-xs text-muted-foreground">Your organizer set this. Your answer is saved but the organizer&apos;s choice applies.</div>}
      {err && <div role="alert" className="text-xs text-destructive">{err}</div>}
    </div>
  );
}
