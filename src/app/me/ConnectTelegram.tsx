"use client";

import { useState } from "react";

/** M6-C — creates a short-lived /connect code for the player's own profile. */
export default function ConnectTelegram({ playerId, connected }: { playerId: string; connected: boolean }) {
  const [result, setResult] = useState<{ command: string; deepLink: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/account/players/${encodeURIComponent(playerId)}/telegram-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setErr(data?.error || "Could not create a code.");
      else setResult({ command: data.command, deepLink: data.deepLink ?? null });
    } catch {
      setErr("Could not create a code.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-1 mt-1">
      <button type="button" className="underline text-sm disabled:opacity-60" disabled={busy} onClick={create}>
        {connected ? "Connect a different Telegram account" : "Connect Telegram"}
      </button>
      {err && <div className="text-sm text-red-600">{err}</div>}
      {result && (
        <div className="text-sm space-y-1">
          <div>Send this message to the Team Balance Pro bot in Telegram (expires in 15 minutes, works once):</div>
          <code className="block break-all bg-gray-50 border rounded p-2">{result.command}</code>
          {result.deepLink && (
            <a className="underline" href={result.deepLink} target="_blank" rel="noreferrer">Open in Telegram</a>
          )}
        </div>
      )}
    </div>
  );
}
