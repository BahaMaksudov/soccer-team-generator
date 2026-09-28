"use client";

import { useEffect, useState, type FormEvent } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { positionLabel } from "@/lib/labels";

/**
 * Phase 2D.6D.1 — canonical tenant-bound Players workspace foundation.
 *
 * Deliberately a new, self-contained component rather than an
 * extraction from AdminWorkspace's PlayerSelection.tsx: that
 * component is entangled with generation state (checkbox selection
 * feeding Generate's player list, GK-count for GenerationControls,
 * shared onMessage banner) — pulling Player CRUD out of it cleanly
 * would be a real refactor, not the narrowly-scoped migration this
 * phase asks for. This is intentionally simple: list, create,
 * toggle-active, delete. It proves the canonical API end-to-end; it
 * does not yet replace the preserved AdminWorkspace UI.
 *
 * Receives only organizationSlug/groupSlug (never groupId/
 * organizationId/membershipId) from the canonical Server Component
 * that already validated them — every request this component makes
 * targets adminTenantApiPath(...), never the legacy flat
 * /api/admin/players.
 */

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
  rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  stamina: number;
  isActive: boolean;
};

const POSITIONS: Player["position"][] = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];
const RATINGS: Player["rating"][] = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"];

export default function CanonicalPlayersSection({
  organizationSlug,
  groupSlug,
}: {
  organizationSlug: string;
  groupSlug: string;
}) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [position, setPosition] = useState<Player["position"]>("MIDFIELDER");
  const [rating, setRating] = useState<Player["rating"]>("GOOD");

  const playersUrl = adminTenantApiPath({ organizationSlug, groupSlug, path: "/players" });

  async function load() {
    setLoading(true);
    const res = await fetch(playersUrl, { cache: "no-store" });
    if (res.ok) {
      setPlayers(await res.json());
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Intentional: only re-fetch when the tenant identity itself
    // changes, matching the canonical home/players pages' own pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  async function createPlayer(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const res = await fetch(playersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, position, rating }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMessage(data?.error ?? "Failed to create player");
      return;
    }
    setFirstName("");
    setLastName("");
    setMessage("✅ Player created.");
    load();
  }

  async function toggleActive(p: Player) {
    setMessage(null);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${p.id}` }), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) {
      setMessage("Failed to update player");
      return;
    }
    load();
  }

  async function removePlayer(p: Player) {
    setMessage(null);
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: `/players/${p.id}` }), {
      method: "DELETE",
    });
    if (!res.ok) {
      setMessage("Failed to delete player");
      return;
    }
    load();
  }

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="font-semibold">Players</div>
      <p className="text-xs text-gray-500">
        Tenant-bound workspace foundation — every request targets the canonical API for this Group only.
      </p>

      {message && <div className="text-sm text-blue-700">{message}</div>}

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
              <th className="py-1">Name</th>
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
                <td colSpan={5} className="py-2 text-gray-500">
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
