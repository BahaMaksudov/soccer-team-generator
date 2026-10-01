"use client";

import { useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { accountCellState, createClaimLinkFlow } from "@/lib/claimLinkUi";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * M6-C — a Player's optional account link (organizer view). Shows only
 * booleans (never who claimed it). The one-time claim URL is passed in
 * from the Players section's transient state (`oneTimeLink`), so it
 * survives the list refresh that follows creating it; it lives only in
 * the URL fragment (/claim#…). Owners/admins only — the API answers 404
 * for other roles.
 */
export default function PlayerAccountCell({
  organizationSlug,
  groupSlug,
  player,
  oneTimeLink,
  onLinkCreated,
  onLinkCleared,
  onChanged,
  onMessage,
}: {
  organizationSlug: string;
  groupSlug: string;
  player: Player;
  oneTimeLink: string | null;
  onLinkCreated: (playerId: string, url: string) => void;
  onLinkCleared: (playerId: string) => void;
  onChanged: () => Promise<void> | void;
  onMessage: (msg: string | null) => void;
}) {
  const base = `/players/${player.id}`;
  const claimUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: `${base}/claim` });
  const accountUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: `${base}/account` });
  const [confirm, setConfirm] = useState<"unlink" | "replace" | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = accountCellState(player, oneTimeLink);

  async function call(url: string, method: "POST" | "DELETE") {
    const res = await fetch(url, method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: "{}" } : { method });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  async function createLink() {
    setConfirm(null);
    setCopied(false);
    setBusy(true);
    try {
      const result = await createClaimLinkFlow({
        request: () => call(claimUrl, "POST"),
        origin: window.location.origin,
        rememberLink: (url) => onLinkCreated(player.id, url),
        refresh: onChanged,
      });
      if (!result.ok) onMessage(result.error);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    try {
      const { ok, data } = await call(claimUrl, "DELETE");
      if (!ok) return onMessage(data?.error || "Could not revoke the claim link.");
      onLinkCleared(player.id);
      onMessage(`Claim link for ${player.firstName} ${player.lastName} revoked.`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    setConfirm(null);
    setBusy(true);
    try {
      const { ok, data } = await call(accountUrl, "DELETE");
      if (!ok) return onMessage(data?.error || "Could not unlink the account.");
      onLinkCleared(player.id);
      onMessage(`Account unlinked from ${player.firstName} ${player.lastName}. The player and their history are unchanged.`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!oneTimeLink) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink);
      setCopied(true);
    } catch {
      onMessage("Copy failed — select the link in the box and copy it manually.");
    }
  }

  if (state === "claimed") {
    return (
      <span className="text-xs">
        Claimed{" "}
        {confirm === "unlink" ? (
          <>
            — unlink account?{" "}
            <button type="button" className="underline text-red-600" disabled={busy} onClick={unlink}>Confirm</button>{" "}
            <button type="button" className="underline" onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="underline" onClick={() => setConfirm("unlink")}>Unlink</button>
        )}
      </span>
    );
  }

  if (state === "link_ready" && oneTimeLink) {
    return (
      <span className="text-xs block space-y-1 max-w-xs">
        <span className="block font-medium text-amber-800">Claim link created — copy it now. It will not be shown again.</span>
        <input
          readOnly
          aria-label="Claim link"
          className="w-full border rounded px-1 py-0.5 bg-gray-50 font-mono text-[11px]"
          value={oneTimeLink}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span className="flex flex-wrap gap-2 items-center">
          <button type="button" className="bg-black text-white rounded px-2 py-0.5" onClick={copy}>
            Copy claim link
          </button>
          {copied && <span className="text-green-700">Copied</span>}
          <button type="button" className="underline" onClick={() => onLinkCleared(player.id)}>Done</button>
        </span>
        <span className="block text-gray-500">Share it only with this player. Expires in 7 days.</span>
      </span>
    );
  }

  return (
    <span className="text-xs space-y-1 block">
      <span className="text-gray-600">{state === "pending" ? "Claim link sent" : "Not claimed"}</span>{" "}
      {state === "pending" ? (
        confirm === "replace" ? (
          <>
            — replace it? The current link will stop working.{" "}
            <button type="button" className="underline" disabled={busy} onClick={createLink}>Confirm</button>{" "}
            <button type="button" className="underline" onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="underline" disabled={busy} onClick={() => setConfirm("replace")}>New link</button>{" "}
            <button type="button" className="underline" disabled={busy} onClick={revoke}>Revoke</button>
          </>
        )
      ) : (
        <button type="button" className="underline" disabled={busy} onClick={createLink}>
          {busy ? "Creating…" : "Create claim link"}
        </button>
      )}
    </span>
  );
}
