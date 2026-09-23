"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { positionLabel, ratingLabel } from "@/lib/labels";
import { getPlayerImpactScore, DEFAULT_BALANCE_WEIGHTS, type BalanceWeights } from "@/lib/scoring";
import type { Player } from "../types";

const positions = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"] as const;
const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;

/**
 * Add/Edit Player forms + the players table (select-all, checkboxes,
 * Score column). Owns all player-CRUD state and mutation functions —
 * nothing outside this component needs them. `players`/`selected` stay
 * page-owned (Telegram linking and Generation Controls need them too),
 * so mutations call `refreshPlayers()` (the page's loadPlayers) rather
 * than managing the list locally.
 *
 * `weights` is fetched here, self-contained — the Score column is the
 * only consumer anywhere on this page.
 */
export default function PlayerSelection({
  players,
  selected,
  setSelected,
  selectedIds,
  refreshPlayers,
  onMessage,
}: {
  players: Player[];
  selected: Record<string, boolean>;
  setSelected: Dispatch<SetStateAction<Record<string, boolean>>>;
  selectedIds: string[];
  refreshPlayers: () => Promise<void>;
  onMessage: (msg: string | null) => void;
}) {
  const [weights, setWeights] = useState<BalanceWeights>(DEFAULT_BALANCE_WEIGHTS);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/settings/balance-weights", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data?.weights) setWeights(data.weights);
      }
    })();
  }, []);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [position, setPosition] = useState<Player["position"]>("MIDFIELDER");
  const [rating, setRating] = useState<Player["rating"]>("GOOD");
  const [stamina, setStamina] = useState<number>(3);

  const [editId, setEditId] = useState<string | null>(null);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editPos, setEditPos] = useState<Player["position"]>("MIDFIELDER");
  const [editRating, setEditRating] = useState<Player["rating"]>("GOOD");
  const [editStamina, setEditStamina] = useState<number>(3);

  const editFirstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editId) return;
    const t = setTimeout(() => {
      editFirstInputRef.current?.focus();
      editFirstInputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [editId]);

  // Select All logic (active only)
  const activeIds = useMemo(() => players.filter((p) => p.isActive).map((p) => p.id), [players]);

  const allActiveSelected = useMemo(() => {
    if (activeIds.length === 0) return false;
    const sel = new Set(selectedIds);
    return activeIds.every((id) => sel.has(id));
  }, [activeIds, selectedIds]);

  const someActiveSelected = useMemo(() => {
    if (activeIds.length === 0) return false;
    const sel = new Set(selectedIds);
    return activeIds.some((id) => sel.has(id)) && !allActiveSelected;
  }, [activeIds, selectedIds, allActiveSelected]);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someActiveSelected;
  }, [someActiveSelected]);

  function toggleSelectAll(checked: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) {
        for (const id of activeIds) next[id] = true;
      } else {
        for (const id of activeIds) delete next[id];
      }
      return next;
    });
  }

  async function addPlayer() {
    onMessage(null);
    if (!firstName.trim() || !lastName.trim()) {
      onMessage("Please enter first name and last name.");
      return;
    }

    const res = await fetch("/api/admin/players", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName,
        lastName,
        position,
        rating,
        stamina,
        isActive: true,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to add player");
      return;
    }

    setFirstName("");
    setLastName("");
    setStamina(3);
    await refreshPlayers();
    onMessage("✅ Player saved.");
  }

  function openEdit(p: Player) {
    setEditId(p.id);
    setEditFirst(p.firstName);
    setEditLast(p.lastName);
    setEditPos(p.position);
    setEditRating(p.rating);
    setEditStamina(Number(p.stamina ?? 3));
  }

  async function saveEdit() {
    if (!editId) return;
    onMessage(null);

    const res = await fetch(`/api/admin/players/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: editFirst,
        lastName: editLast,
        position: editPos,
        rating: editRating,
        stamina: editStamina,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      onMessage(data?.error ?? "Failed to update player");
      return;
    }

    setEditId(null);
    await refreshPlayers();
    onMessage("✅ Player updated.");
  }

  async function toggleActive(p: Player) {
    const res = await fetch(`/api/admin/players/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) onMessage("Failed to update player");
    await refreshPlayers();
  }

  async function deletePlayer(id: string) {
    const ok = confirm("Delete this player?");
    if (!ok) return;
    const res = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!res.ok) onMessage("Failed to delete player");
    await refreshPlayers();
  }

  return (
    <>
      {/* Add Player */}
      <div className="border rounded-xl p-4 space-y-3 bg-white mt-4">
        <div className="font-semibold">Add Player</div>

        <div className="hidden md:grid md:grid-cols-7 gap-3 text-xs font-medium text-gray-600 px-1">
          <div>First name</div>
          <div>Last name</div>
          <div>Position</div>
          <div>Rank</div>
          <div>Stamina level</div>
          <div className="md:col-span-2"></div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          <div>
            <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">First name</label>
            <input
              className="border rounded-md px-3 py-2 w-full"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>

          <div>
            <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Last name</label>
            <input
              className="border rounded-md px-3 py-2 w-full"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>

          <div>
            <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Position</label>
            <select
              className="border rounded-md px-3 py-2 w-full"
              value={position}
              onChange={(e) => setPosition(e.target.value as Player["position"])}
            >
              {positions.map((p) => (
                <option key={p} value={p}>
                  {positionLabel(p)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Rank</label>
            <select
              className="border rounded-md px-3 py-2 w-full"
              value={rating}
              onChange={(e) => setRating(e.target.value as Player["rating"])}
            >
              {ratings.map((r) => (
                <option key={r} value={r}>
                  {ratingLabel(r)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Stamina level</label>
            <select
              className="border rounded-md px-3 py-2 w-full"
              value={stamina}
              onChange={(e) => setStamina(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2 flex items-end">
            <button className="bg-black text-white rounded-md py-2 w-full" onClick={addPlayer}>
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Edit Player */}
      {editId && (
        <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
          <div className="font-semibold">Edit Player</div>

          <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">First name</label>
              <input
                ref={editFirstInputRef}
                className="border rounded-md px-3 py-2 w-full"
                value={editFirst}
                onChange={(e) => setEditFirst(e.target.value)}
              />
            </div>

            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Last name</label>
              <input
                className="border rounded-md px-3 py-2 w-full"
                value={editLast}
                onChange={(e) => setEditLast(e.target.value)}
              />
            </div>

            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Position</label>
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={editPos}
                onChange={(e) => setEditPos(e.target.value as Player["position"])}
              >
                {positions.map((p) => (
                  <option key={p} value={p}>
                    {positionLabel(p)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Rank</label>
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={editRating}
                onChange={(e) => setEditRating(e.target.value as Player["rating"])}
              >
                {ratings.map((r) => (
                  <option key={r} value={r}>
                    {ratingLabel(r)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Stamina level</label>
              <select
                className="border rounded-md px-3 py-2 w-full"
                value={editStamina}
                onChange={(e) => setEditStamina(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2 flex items-end gap-2">
              <button className="bg-black text-white rounded-md px-4 py-2 w-full" onClick={saveEdit}>
                Save
              </button>
              <button className="border rounded-md px-4 py-2 w-full" onClick={() => setEditId(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Players table */}
      <div className="border rounded-xl overflow-hidden bg-white mt-4">
        <div className="p-4 font-semibold">Players (select for team generation)</div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-3 text-left w-14">
                  <div className="flex items-center gap-2">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allActiveSelected}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                      disabled={activeIds.length === 0}
                      title="Select all active players"
                    />
                    <span className="text-xs text-gray-600">All</span>
                  </div>
                </th>
                <th className="p-3 text-left">Name</th>
                <th className="p-3 text-left">Position</th>
                <th className="p-3 text-left">Rating</th>
                <th className="p-3 text-left">Stamina</th>
                <th className="p-3 text-left">Score</th>
                <th className="p-3 text-left">Active</th>
                <th className="p-3 text-left w-40">Actions</th>
              </tr>
            </thead>

            <tbody>
              {players.map((p) => {
                const score = getPlayerImpactScore(p, weights);
                return (
                  <tr key={p.id} className="border-t">
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={!!selected[p.id]}
                        onChange={(e) => setSelected((s) => ({ ...s, [p.id]: e.target.checked }))}
                        disabled={!p.isActive}
                      />
                    </td>

                    <td className="p-3">
                      {p.firstName} {p.lastName}
                    </td>
                    <td className="p-3 text-gray-700">{positionLabel(p.position)}</td>
                    <td className="p-3">{ratingLabel(p.rating)}</td>
                    <td className="p-3">{Number(p.stamina)}</td>
                    <td className="p-3 font-semibold">{score}</td>

                    <td className="p-3">
                      <button className="underline" onClick={() => toggleActive(p)}>
                        {p.isActive ? "Yes" : "No"}
                      </button>
                    </td>

                    <td className="p-3">
                      <div className="flex gap-3">
                        <button className="underline" onClick={() => openEdit(p)}>
                          Edit
                        </button>
                        <button className="text-red-700 underline" onClick={() => deletePlayer(p.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {players.length === 0 && (
                <tr>
                  <td className="p-3 text-gray-500" colSpan={8}>
                    No players yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 pb-4 text-xs text-slate-500">
          Score = rating×10 + stamina×2×staminaCoef + positionWeight×3 (configurable in{" "}
          <Link className="underline" href="/admin/settings">
            Settings
          </Link>
          )
        </div>
      </div>
    </>
  );
}
