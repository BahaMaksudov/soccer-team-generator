"use client";

import { useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * M6.1 — a Player's Telegram connection (organizer view): a boolean only,
 * never the Telegram user id. "Remove Telegram link" deletes just this
 * Player's link in this Group, after confirmation. Owners/admins only —
 * the API answers 404 for other roles.
 */
export default function PlayerTelegramCell({
  organizationSlug,
  groupSlug,
  player,
  onChanged,
  onMessage,
  canManage = true,
}: {
  /** M9-A — MEMBER sees the status only (no identity actions). */
  canManage?: boolean;
  organizationSlug: string;
  groupSlug: string;
  player: Player;
  onChanged: () => Promise<void> | void;
  onMessage: (msg: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = `${player.firstName} ${player.lastName}`;

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${player.id}/telegram` }), { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return onMessage(data?.error || "Could not remove the Telegram link.");
      setConfirming(false);
      onMessage(`Telegram link removed for ${name}. The player and their history are unchanged.`);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!player.telegramConnected) return <span className="text-xs text-gray-600">Not connected</span>;

  if (confirming) {
    return (
      <span className="text-xs block space-y-1 max-w-xs">
        <span className="block">Remove the Telegram connection for {name}?</span>
        <span className="block text-gray-500">
          This only removes the Telegram connection for this player in this group. It does not delete the player or their history.
        </span>
        <span className="flex gap-2">
          <button type="button" className="underline text-red-600" disabled={busy} onClick={remove}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" className="underline" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      </span>
    );
  }

  return (
    <span className="text-xs">
      Connected{" "}
      {canManage && (
        <button type="button" className="underline" onClick={() => setConfirming(true)}>
          Remove Telegram link
        </button>
      )}
    </span>
  );
}
