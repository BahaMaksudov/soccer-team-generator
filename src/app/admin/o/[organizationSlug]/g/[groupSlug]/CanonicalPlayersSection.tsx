"use client";

import { useState, type FormEvent } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { positionLabel } from "@/lib/labels";
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
 * Deliberately a new, self-contained component rather than an
 * extraction from AdminWorkspace's PlayerSelection.tsx — still true
 * after this phase's refactor; AdminWorkspace itself is untouched.
 *
 * Receives only organizationSlug/groupSlug (never groupId/
 * organizationId/membershipId). Every request targets
 * adminTenantApiPath(...), never the legacy flat /api/admin/players.
 */

const POSITIONS: Player["position"][] = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];
const RATINGS: Player["rating"][] = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"];

export default function CanonicalPlayersSection({
  organizationSlug,
  groupSlug,
  players,
  loading,
  selected,
  onToggleSelected,
  onMessage,
  refreshPlayers,
}: {
  organizationSlug: string;
  groupSlug: string;
  players: Player[];
  loading: boolean;
  selected: Record<string, boolean>;
  onToggleSelected: (id: string) => void;
  onMessage: (msg: string | null) => void;
  refreshPlayers: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [position, setPosition] = useState<Player["position"]>("MIDFIELDER");
  const [rating, setRating] = useState<Player["rating"]>("GOOD");

  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });

  async function createPlayer(e: FormEvent) {
    e.preventDefault();
    onMessage(null);
    const res = await fetch(playersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, position, rating }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to create player");
      return;
    }
    setFirstName("");
    setLastName("");
    onMessage("✅ Player created.");
    refreshPlayers();
  }

  async function toggleActive(p: Player) {
    onMessage(null);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${p.id}` }), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) {
      onMessage("Failed to update player");
      return;
    }
    refreshPlayers();
  }

  async function removePlayer(p: Player) {
    onMessage(null);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${p.id}` }), {
      method: "DELETE",
    });
    if (!res.ok) {
      onMessage("Failed to delete player");
      return;
    }
    refreshPlayers();
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Players</div>
      <p className="text-xs text-gray-500">
        Tenant-bound workspace — every request targets the canonical API for this Group only. Check a player to
        select them for team generation below.
      </p>

      <form onSubmit={createPlayer} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs">First name</label>
          <input
            className="border rounded px-2 py-1 text-sm"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs">Last name</label>
          <input
            className="border rounded px-2 py-1 text-sm"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs">Position</label>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={position}
            onChange={(e) => setPosition(e.target.value as Player["position"])}
          >
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {positionLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs">Rating</label>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={rating}
            onChange={(e) => setRating(e.target.value as Player["rating"])}
          >
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="bg-black text-white rounded px-3 py-1 text-sm">
          Add player
        </button>
      </form>

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b">
              <th className="py-1"></th>
              <th>Name</th>
              <th>Position</th>
              <th>Rating</th>
              <th>Status</th>
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
                <td>{p.rating}</td>
                <td>
                  <button className="underline text-xs" onClick={() => toggleActive(p)}>
                    {p.isActive ? "Active" : "Inactive"}
                  </button>
                </td>
                <td>
                  <button className="underline text-xs text-red-600" onClick={() => removePlayer(p)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {players.length === 0 && (
              <tr>
                <td colSpan={6} className="py-2 text-gray-500">
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
