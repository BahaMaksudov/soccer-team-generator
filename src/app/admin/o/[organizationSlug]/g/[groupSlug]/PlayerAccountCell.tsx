"use client";

import { useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * M6-C — a Player's optional account link (organizer view). Shows only
 * booleans (never who claimed it). A claim link is displayed once, right
 * after it is created; it lives only in the URL fragment (/claim#…).
 * Owners/admins only — the API answers 404 for other roles.
 */
export default function PlayerAccountCell({
  organizationSlug,
  groupSlug,
  player,
  onChanged,
  onMessage,
}: {
  organizationSlug: string;
  groupSlug: string;
  player: Player;
  onChanged: () => Promise<void> | void;
  onMessage: (msg: string | null) => void;
}) {
  const base = `/players/${player.id}`;
  const claimUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: `${base}/claim` });
  const accountUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: `${base}/account` });
  const [link, setLink] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [busy, setBusy] = useState(false);

  async function call(url: string, method: "POST" | "DELETE") {
    setBusy(true);
    try {
      const res = await fetch(url, method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: "{}" } : { method });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    } finally {
      setBusy(false);
    }
  }

  async function createLink() {
    const { ok, data } = await call(claimUrl, "POST");
    if (!ok) return onMessage(data?.error || "Could not create a claim link.");
    setLink(`${window.location.origin}${data.claimPath}`);
    await onChanged();
  }
  async function revoke() {
    const { ok, data } = await call(claimUrl, "DELETE");
    if (!ok) return onMessage(data?.error || "Could not revoke the claim link.");
    setLink(null);
    onMessage(`Claim link for ${player.firstName} ${player.lastName} revoked.`);
    await onChanged();
  }
  async function unlink() {
    setConfirmUnlink(false);
    const { ok, data } = await call(accountUrl, "DELETE");
    if (!ok) return onMessage(data?.error || "Could not unlink the account.");
    onMessage(`Account unlinked from ${player.firstName} ${player.lastName}. The player and their history are unchanged.`);
    await onChanged();
  }
  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onMessage("Claim link copied. Share it only with this player.");
    } catch {
      onMessage("Copy failed — select the link and copy it manually.");
    }
  }

  if (player.accountClaimed) {
    return (
      <span className="text-xs">
        Claimed{" "}
        {confirmUnlink ? (
          <>
            — unlink account?{" "}
            <button className="underline text-red-600" disabled={busy} onClick={unlink}>Confirm</button>{" "}
            <button className="underline" onClick={() => setConfirmUnlink(false)}>Cancel</button>
          </>
        ) : (
          <button className="underline" onClick={() => setConfirmUnlink(true)}>Unlink</button>
        )}
      </span>
    );
  }

  return (
    <span className="text-xs space-y-1 block">
      <span className="text-gray-600">{player.claimPending ? "Claim link sent" : "Not claimed"}</span>{" "}
      <button className="underline" disabled={busy} onClick={createLink}>
        {player.claimPending ? "New link" : "Create claim link"}
      </button>
      {player.claimPending && (
        <>
          {" "}
          <button className="underline" disabled={busy} onClick={revoke}>Revoke</button>
        </>
      )}
      {link && (
        <span className="block">
          <code className="block break-all bg-gray-50 border rounded p-1 my-1">{link}</code>
          <button className="underline" onClick={copy}>Copy claim link</button>{" "}
          <span className="text-gray-500">(shown once · expires in 7 days)</span>
        </span>
      )}
    </span>
  );
}
