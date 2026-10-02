"use client";

import { useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";

type Channel = { ref: number; title: string; connectedAt: string };
type Bind = { code: string; deepLink: string | null; command: string; expiresAt: string };

/**
 * M9-A — Communication Channels (OWNER/ADMIN). Telegram: connected groups
 * (titles only — never raw chat ids), Connect via a one-time code redeemed
 * in the Telegram group by one of its administrators, and Disconnect (with
 * confirmation; history is kept). WhatsApp: share links arrive in M9-B.
 */
export default function CommunicationChannelsSection({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const url = adminTenantApiPath({ organizationSlug, groupSlug, path: "/channels/telegram" });
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [bind, setBind] = useState<Bind | null>(null);
  const [confirmRef, setConfirmRef] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) setChannels((await res.json()).telegram);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  async function connect() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(data?.error ?? "Could not create a connect code.");
      else setBind(data);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(ref: number) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${url}/${ref}`, { method: "DELETE" });
      if (!res.ok) setMsg("Could not disconnect.");
      else {
        setMsg("Telegram group disconnected. Past polls and messages are kept.");
        setConfirmRef(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3 text-sm">
      <div className="font-semibold">Communication Channels</div>

      <div className="space-y-2">
        <div className="font-medium">Telegram</div>
        {channels === null ? (
          <div className="text-gray-500">Loading…</div>
        ) : channels.length === 0 ? (
          <div className="text-gray-600">Not connected</div>
        ) : (
          <ul className="space-y-1">
            {channels.map((c) => (
              <li key={c.ref} className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-700">Connected</span> · <span>{c.title}</span>
                {confirmRef === c.ref ? (
                  <span>
                    Disconnect this Telegram group? Polls can&apos;t be posted there until it is connected again.{" "}
                    <button type="button" className="underline text-red-600" disabled={busy} onClick={() => disconnect(c.ref)}>Disconnect</button>{" "}
                    <button type="button" className="underline" onClick={() => setConfirmRef(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="underline" onClick={() => setConfirmRef(c.ref)}>Disconnect</button>
                )}
              </li>
            ))}
          </ul>
        )}

        <button type="button" disabled={busy} className="border rounded px-3 py-1 disabled:opacity-60" onClick={connect}>
          Connect Telegram Group
        </button>

        {bind && (
          <div className="border rounded-lg p-3 bg-gray-50 space-y-1">
            <div>1. Add the Team Balance Pro bot to your Telegram group{bind.deepLink ? ":" : "."}</div>
            {bind.deepLink && (
              <a className="underline" href={bind.deepLink} target="_blank" rel="noreferrer">
                Add bot to a Telegram group
              </a>
            )}
            <div>2. If the group doesn&apos;t confirm automatically, a group administrator sends this message there:</div>
            <code className="block break-all bg-white border rounded p-2">{bind.command}</code>
            <div className="text-xs text-gray-500">Works once, expires in 15 minutes, and must be sent by an administrator of that Telegram group.</div>
            <button type="button" className="underline text-xs" onClick={() => { setBind(null); load(); }}>
              Done — refresh
            </button>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="font-medium">WhatsApp</div>
        <div className="text-gray-600">Share links are coming soon.</div>
      </div>

      {msg && <div className="text-blue-700">{msg}</div>}
    </div>
  );
}
