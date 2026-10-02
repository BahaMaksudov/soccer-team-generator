"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
}: {
  matchId: string;
  status: "PLAYING" | "NOT_PLAYING" | "MAYBE" | null;
  byOrganizer: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      if (!res.ok) setErr("Could not save your answer.");
      else router.refresh();
    } catch {
      setErr("Could not save your answer.");
    }
    setBusy(false);
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
            className={`text-sm rounded-full border px-3 py-1 disabled:opacity-60 ${status === o.status ? "bg-black text-white border-black" : "bg-white"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {byOrganizer && <div className="text-xs text-gray-500">Your organizer set this. Your answer is saved but the organizer&apos;s choice applies.</div>}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}
