"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * M6-C — creates a short-lived /connect code for the player's own profile.
 * M6.1 — when connected, offers "Disconnect Telegram" instead (with
 * confirmation); this removes only this Player's link in its own Group.
 */
export default function ConnectTelegram({ playerId, connected }: { playerId: string; connected: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<{ command: string; deepLink: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const base = `/api/account/players/${encodeURIComponent(playerId)}`;

  async function create() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${base}/telegram-connect`, {
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

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${base}/telegram`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setErr(data?.error || "Could not disconnect Telegram.");
      else {
        setConfirming(false);
        setResult(null);
        router.refresh();
      }
    } catch {
      setErr("Could not disconnect Telegram.");
    }
    setBusy(false);
  }

  if (connected) {
    return (
      <div className="space-y-1 mt-1">
        {confirming ? (
          <div className="text-sm space-y-1">
            <div>Disconnect Telegram from this player? Your poll votes will no longer be matched to you in this group until you connect again.</div>
            <button type="button" className="underline text-red-600 disabled:opacity-60" disabled={busy} onClick={disconnect}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>{" "}
            <button type="button" className="underline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="underline text-sm" onClick={() => setConfirming(true)}>
            Disconnect Telegram
          </button>
        )}
        {err && <div className="text-sm text-red-600">{err}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-1 mt-1">
      <button type="button" className="underline text-sm disabled:opacity-60" disabled={busy} onClick={create}>
        Connect Telegram
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
