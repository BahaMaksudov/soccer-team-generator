"use client";

import { useEffect, useRef, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { positionLabel, ratingLabel } from "@/lib/labels";
import {
  emptyPlayerForm,
  playerFormFromPlayer,
  playerFormToBody,
  selectAllActiveState,
  type PlayerFormValues,
} from "@/lib/canonicalAdminState";
import CanonicalPlayerForm from "./CanonicalPlayerForm";
import PlayerAccountCell from "./PlayerAccountCell";
import type { Player } from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6D.1 — canonical tenant-bound Players workspace foundation.
 * Phase 2D.6D.2 — state lifted to CanonicalAdminWorkspace (players/
 * loading/refresh are now props, not owned here) so Generate can
 * share the same Player list/fetch instead of loading it a second
 * time independently (Phase 2D.6D.2 report §"avoid duplicate state").
 * Also gained a selection checkbox per row, feeding
 * CanonicalGenerateSection's selectedIds.
 *
 * Phase 2D.6D.5E.3 — full Player parity with the legacy workspace:
 * Create and Edit share CanonicalPlayerForm (first/last name, position,
 * rating, stamina, active); Edit uses canonical PATCH /players/[id];
 * Delete asks for confirmation; a Stamina column and a "select all
 * active" header checkbox. Selection still lives only in
 * CanonicalAdminWorkspace — this component never owns a second copy.
 *
 * Receives only organizationSlug/groupSlug (never groupId/
 * organizationId/membershipId). Every request targets
 * adminTenantApiPath(...), never the legacy flat /api/admin/players.
 */

export default function CanonicalPlayersSection({
  organizationSlug,
  groupSlug,
  players,
  loading,
  selected,
  onToggleSelected,
  onSelectAllActive,
  onMessage,
  refreshPlayers,
}: {
  organizationSlug: string;
  groupSlug: string;
  players: Player[];
  loading: boolean;
  selected: Record<string, boolean>;
  onToggleSelected: (id: string) => void;
  onSelectAllActive: (checked: boolean) => void;
  onMessage: (msg: string | null) => void;
  refreshPlayers: () => Promise<void> | void;
}) {
  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });
  const playerUrl = (id: string) => adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${id}` });

  // Bumped after a successful create to remount (reset) the create form.
  const [createFormKey, setCreateFormKey] = useState(0);
  const [editing, setEditing] = useState<Player | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // M6-C fix — one-time claim URLs, by Player id, in transient memory only
  // (never storage). Owned here, not by the row, so refreshing the list
  // after creating a link can never discard it.
  const [oneTimeClaimLinks, setOneTimeClaimLinks] = useState<Record<string, string>>({});
  const rememberClaimLink = (playerId: string, url: string) => setOneTimeClaimLinks((prev) => ({ ...prev, [playerId]: url }));
  const forgetClaimLink = (playerId: string) =>
    setOneTimeClaimLinks((prev) => {
      const next = { ...prev };
      delete next[playerId];
      return next;
    });

  async function createPlayer(values: PlayerFormValues): Promise<string | null> {
    onMessage(null);
    const res = await fetch(playersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playerFormToBody(values)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data?.error ?? "Failed to create player";
    setCreateFormKey((k) => k + 1);
    onMessage("✅ Player created.");
    await refreshPlayers();
    return null;
  }

  async function saveEdit(values: PlayerFormValues): Promise<string | null> {
    if (!editing) return null;
    onMessage(null);
    const res = await fetch(playerUrl(editing.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playerFormToBody(values)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data?.error ?? "Failed to update player";
    setEditing(null);
    onMessage("✅ Player updated.");
    await refreshPlayers();
    return null;
  }

  async function toggleActive(p: Player) {
    onMessage(null);
    const res = await fetch(playerUrl(p.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) {
      onMessage("Failed to update player");
      return;
    }
    await refreshPlayers();
  }

  async function removePlayer(p: Player) {
    onMessage(null);
    setConfirmDeleteId(null);
    const res = await fetch(playerUrl(p.id), { method: "DELETE" });
    if (!res.ok) {
      onMessage("Failed to delete player");
      return;
    }
    if (editing?.id === p.id) setEditing(null);
    onMessage(`Deleted ${p.firstName} ${p.lastName}.`);
    await refreshPlayers();
  }

  const selectAll = selectAllActiveState(selected, players);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectAll === "some";
  }, [selectAll]);

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Players</div>
      <p className="text-xs text-gray-500">
        Tenant-bound workspace — every request targets the canonical API for this Group only. Check a player to
        select them for team generation below.
      </p>

      <div className="space-y-1">
        <div className="text-sm font-medium">Add Player</div>
        <CanonicalPlayerForm
          key={createFormKey}
          initial={emptyPlayerForm()}
          submitLabel="Add player"
          busyLabel="Adding…"
          onSubmit={createPlayer}
        />
      </div>

      {editing && (
        <div className="space-y-1 border rounded-lg p-3 bg-gray-50">
          <div className="text-sm font-medium">
            Edit Player: {editing.firstName} {editing.lastName}
          </div>
          <CanonicalPlayerForm
            key={editing.id}
            initial={playerFormFromPlayer(editing)}
            submitLabel="Save changes"
            busyLabel="Saving…"
            onSubmit={saveEdit}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {/* Only the very first load shows "Loading…": a background refresh must
          keep the table (and its one-time claim links) mounted. */}
      {loading && players.length === 0 ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-1">
                <label className="flex items-center gap-1 text-xs text-gray-600" title="Select all active players">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={selectAll === "all"}
                    disabled={!players.some((p) => p.isActive)}
                    onChange={(e) => onSelectAllActive(e.target.checked)}
                  />
                  All
                </label>
              </th>
              <th>Name</th>
              <th>Position</th>
              <th>Rating</th>
              <th>Stamina</th>
              <th>Status</th>
              <th title="Optional Team Balance Pro account (players never need one)">Account</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="py-1">
                  <input
                    type="checkbox"
                    checked={!!selected[p.id]}
                    disabled={!p.isActive}
                    onChange={() => onToggleSelected(p.id)}
                  />
                </td>
                <td>
                  {p.firstName} {p.lastName}
                </td>
                <td>{positionLabel(p.position)}</td>
                <td>{ratingLabel(p.rating)}</td>
                <td>{Number(p.stamina)}</td>
                <td>
                  <button className="underline text-xs" onClick={() => toggleActive(p)}>
                    {p.isActive ? "Active" : "Inactive"}
                  </button>
                </td>
                <td>
                  <PlayerAccountCell
                    organizationSlug={organizationSlug}
                    groupSlug={groupSlug}
                    player={p}
                    oneTimeLink={oneTimeClaimLinks[p.id] ?? null}
                    onLinkCreated={rememberClaimLink}
                    onLinkCleared={forgetClaimLink}
                    onChanged={refreshPlayers}
                    onMessage={onMessage}
                  />
                </td>
                <td className="whitespace-nowrap">
                  {confirmDeleteId === p.id ? (
                    <span className="text-xs">
                      Delete {p.firstName} {p.lastName}?{" "}
                      <button className="underline text-red-600" onClick={() => removePlayer(p)}>
                        Confirm
                      </button>{" "}
                      <button className="underline" onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex gap-3">
                      <button className="underline text-xs" onClick={() => setEditing(p)}>
                        Edit
                      </button>
                      <button className="underline text-xs text-red-600" onClick={() => setConfirmDeleteId(p.id)}>
                        Delete
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {players.length === 0 && (
              <tr>
                <td colSpan={8} className="py-2 text-gray-500">
                  No players yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
