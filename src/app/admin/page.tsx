"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { positionLabel, ratingLabel } from "@/lib/labels";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
  rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  stamina: number;
  isActive: boolean;
};

type TelegramUser = {
  userId: string; // BigInt as string
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

const positions = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"] as const;
const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;

/* ---------------- Score helpers ---------------- */

const ratingWeight: Record<Player["rating"], number> = {
  FAIR: 1,
  GOOD: 2,
  VERY_GOOD: 3,
  EXCELLENT: 4,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function positionWeight(pos: Player["position"]): number {
  switch (pos) {
    case "DEFENDER":
      return 1;
    case "MIDFIELDER":
    case "FORWARD":
    case "GOALKEEPER":
      return 2;
    default:
      return 1;
  }
}

function computeScore(p: Player) {
  const rw = ratingWeight[p.rating] ?? 2;
  const st = Number.isFinite(Number(p.stamina)) ? clamp(Number(p.stamina), 1, 5) : 3;
  const pw = positionWeight(p.position);
  return rw * 10 + st * 2 + pw * 3;
}

export default function AdminPage() {
  const [teamName, setTeamName] = useState("");
  const [teamNameSaving, setTeamNameSaving] = useState(false);

  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [teamCount, setTeamCount] = useState(2);
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  // keep messages near their sections
  const [mainMsg, setMainMsg] = useState<string | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const [previewTeams, setPreviewTeams] = useState<any[] | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);

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

  const [deleteDate, setDeleteDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Telegram linking/import state
  const [telegramUsers, setTelegramUsers] = useState<TelegramUser[]>([]);
  const [tgBusy, setTgBusy] = useState(false);
  const [linkSelection, setLinkSelection] = useState<Record<string, string>>({}); // userId -> playerId
  const [pollIdInput, setPollIdInput] = useState("");

  async function loadPlayers() {
    setMainMsg(null);
    const res = await fetch("/api/admin/players", { cache: "no-store" });
    if (!res.ok) {
      setMainMsg("You must be logged in as admin.");
      return;
    }
    const data = await res.json();
    setPlayers(data);
  }

  async function loadTelegramUsers() {
    setTgMsg(null);
    const res = await fetch("/api/admin/telegram/users", { cache: "no-store" });
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      setTgMsg(data?.error ?? "Failed to load Telegram users");
      return;
    }
    setTelegramUsers(Array.isArray(data) ? data : []);
  }

  useEffect(() => {
    loadPlayers();
    loadTelegramUsers();

    (async () => {
      const res = await fetch("/api/admin/settings/team-name", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTeamName(data.teamName || "");
      }
    })();
  }, []);

  useEffect(() => {
    if (!editId) return;
    const t = setTimeout(() => {
      editFirstInputRef.current?.focus();
      editFirstInputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [editId]);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  const selectedGKCount = useMemo(() => {
    const sel = new Set(selectedIds);
    return players.filter((p) => sel.has(p.id) && p.position === "GOALKEEPER" && p.isActive).length;
  }, [players, selectedIds]);

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
    setMainMsg(null);
    if (!firstName.trim() || !lastName.trim()) {
      setMainMsg("Please enter first name and last name.");
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
      setMainMsg(data?.error ?? "Failed to add player");
      return;
    }

    setFirstName("");
    setLastName("");
    setStamina(3);
    await loadPlayers();
    setMainMsg("✅ Player saved.");
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
    setMainMsg(null);

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
      setMainMsg(data?.error ?? "Failed to update player");
      return;
    }

    setEditId(null);
    await loadPlayers();
    setMainMsg("✅ Player updated.");
  }

  async function deletePublishedTeams() {
    setDeleteMsg(null);

    const ok = confirm(`Delete published teams for ${deleteDate}? This cannot be undone.`);
    if (!ok) return;

    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/admin/publish?date=${encodeURIComponent(deleteDate)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setDeleteMsg(data?.error ?? "Failed to delete published teams");
        return;
      }

      setDeleteMsg(`✅ Deleted published teams for ${deleteDate}. (${data.deleted} record(s))`);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function toggleActive(p: Player) {
    const res = await fetch(`/api/admin/players/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) setMainMsg("Failed to update player");
    await loadPlayers();
  }

  async function deletePlayer(id: string) {
    const ok = confirm("Delete this player?");
    if (!ok) return;
    const res = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!res.ok) setMainMsg("Failed to delete player");
    await loadPlayers();
  }

  async function generate() {
    setMainMsg(null);
    const res = await fetch("/api/admin/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamCount, date: new Date(date).toISOString(), selectedIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMainMsg(data?.error ?? "Failed to generate");
      return;
    }
    setPreviewTeams(data.teams);
    setPreviewDate(data.date);
    setMainMsg("Preview generated. If it looks good, click Publish. You can regenerate multiple times.");
  }

  async function publish() {
    setMainMsg(null);
    if (!previewTeams || !previewDate) {
      setMainMsg("Generate teams first, then publish.");
      return;
    }
    const res = await fetch("/api/admin/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: previewDate, teams: previewTeams }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMainMsg(data?.error ?? "Failed to publish");
      return;
    }
    setMainMsg("✅ Published! Home page updated for that date (previous teams replaced).");
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    setMainMsg("Preview cleared.");
  }

  async function saveTeamName() {
    setMainMsg(null);
    const name = teamName.trim();
    if (!name) {
      setMainMsg("Team name is required.");
      return;
    }

    setTeamNameSaving(true);
    const res = await fetch("/api/admin/settings/team-name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: name }),
    });
    setTeamNameSaving(false);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMainMsg(data?.error ?? "Failed to update team name");
      return;
    }

    setTeamName(data.teamName || name);
    setMainMsg("✅ Team name updated.");
  }

  async function linkTelegramUser(userId: string) {
    const playerId = linkSelection[userId];
    if (!playerId) {
      setTgMsg("Pick a player for that Telegram user first.");
      return;
    }

    setTgBusy(true);
    setTgMsg(null);
    try {
      const res = await fetch("/api/admin/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, playerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTgMsg(data?.error ?? "Failed to link Telegram user");
        return;
      }
      setTgMsg("✅ Linked.");
      await loadTelegramUsers(); // will remove linked user from list
    } finally {
      setTgBusy(false);
    }
  }

  async function importFromTelegramPoll() {
    setImportMsg(null);
    const pollId = pollIdInput.trim();
    if (!pollId) {
      setImportMsg("Poll ID is required.");
      return;
    }

    const res = await fetch("/api/admin/telegram/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setImportMsg(data?.error ?? "Failed to import from Telegram poll");
      return;
    }

    const ids: string[] = data.selectedPlayerIds ?? [];
    const missing: string[] = data.missingUserIds ?? [];

    // auto-select imported players
    setSelected((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = true;
      return next;
    });

    if (missing.length) {
      setImportMsg(
        `Imported ✅ Playing votes, but ${missing.length} Telegram user(s) are not linked yet. Link them above, then import again.`
      );
    } else {
      setImportMsg(`✅ Imported & selected ${ids.length} player(s) from poll.`);
    }
  }

  const playerOptions = useMemo(() => {
    // show active players first
    const sorted = [...players].sort((a, b) => Number(b.isActive) - Number(a.isActive));
    return sorted;
  }, [players]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Admin</h1>

          <div className="ml-auto flex items-center gap-4">
            <Link className="text-sm underline" href="/admin/settings">
              Settings
            </Link>

            <button className="text-sm underline" onClick={() => signOut({ callbackUrl: "/" })}>
              Sign out
            </button>
          </div>
        </div>

        {mainMsg && <div className="text-sm text-blue-700 mt-2">{mainMsg}</div>}

        {/* Team Settings */}
        <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
          <div className="font-semibold">Team Settings</div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="block text-sm mb-1">Team Name (shows in header)</label>
              <input
                className="border rounded-md px-3 py-2 w-full"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="New England Eagles"
              />
            </div>

            <button
              className="bg-black text-white rounded-md py-2 disabled:opacity-60"
              disabled={teamNameSaving}
              onClick={saveTeamName}
            >
              {teamNameSaving ? "Saving..." : "Save Team Name"}
            </button>
          </div>

          <div className="text-xs text-gray-500">This updates instantly in Neon DB (no redeploy needed).</div>
        </div>

        {/* Link Telegram Users -> Players */}
        <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
          <div className="flex items-center">
            <div className="font-semibold">Link Telegram Users → Players</div>
            <button
              className="ml-auto text-sm underline"
              onClick={() => loadTelegramUsers()}
              disabled={tgBusy}
              title="Refresh Telegram users list"
            >
              Refresh
            </button>
          </div>

          <div className="text-xs text-gray-500">
            One-time mapping. Telegram usernames can be empty — mapping uses <b>userId</b> which is stable.
          </div>

          {tgMsg && <div className="text-sm text-blue-700">{tgMsg}</div>}

          {telegramUsers.length === 0 ? (
            <div className="text-sm text-gray-600">
              No unlinked Telegram users found yet. Ask people to vote once.
            </div>
          ) : (
            <div className="space-y-3">
              {telegramUsers.map((u) => {
                const label =
                  (u.username ? `@${u.username}` : null) ||
                  [u.firstName, u.lastName].filter(Boolean).join(" ") ||
                  `userId ${u.userId}`;

                return (
                  <div key={u.userId} className="border rounded-lg p-3 flex flex-col md:flex-row md:items-center gap-3">
                    <div className="text-sm font-medium md:w-64">{label}</div>

                    <select
                      className="border rounded-md px-3 py-2 w-full md:flex-1"
                      value={linkSelection[u.userId] ?? ""}
                      onChange={(e) =>
                        setLinkSelection((prev) => ({
                          ...prev,
                          [u.userId]: e.target.value,
                        }))
                      }
                    >
                      <option value="">Select a player…</option>
                      {playerOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.firstName} {p.lastName} {p.isActive ? "" : "(inactive)"}
                        </option>
                      ))}
                    </select>

                    <button
                      className="bg-black text-white rounded-md px-4 py-2 disabled:opacity-60"
                      onClick={() => linkTelegramUser(u.userId)}
                      disabled={tgBusy}
                    >
                      Link
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Import from Telegram Poll */}
        <div className="border rounded-xl p-4 bg-white space-y-3 mt-4">
          <div className="font-semibold">Import from Telegram Poll</div>
          <div className="text-xs text-gray-500">
            Paste Poll ID (<code>TelegramPoll.pollId</code>). We’ll select all players who voted ✅ Playing (option index 0).
          </div>

          {importMsg && <div className="text-sm text-blue-700">{importMsg}</div>}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="block text-sm mb-1">Poll ID</label>
              <input
                className="border rounded-md px-3 py-2 w-full"
                value={pollIdInput}
                onChange={(e) => setPollIdInput(e.target.value)}
                placeholder="e.g. 5138929074038636813"
              />
            </div>

            <button className="bg-indigo-600 text-white rounded-md py-2" onClick={importFromTelegramPoll}>
              Import & Select Players
            </button>
          </div>
        </div>

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
                onChange={(e) => setPosition(e.target.value as any)}
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
              <select className="border rounded-md px-3 py-2 w-full" value={rating} onChange={(e) => setRating(e.target.value as any)}>
                {ratings.map((r) => (
                  <option key={r} value={r}>
                    {ratingLabel(r)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Stamina level</label>
              <select className="border rounded-md px-3 py-2 w-full" value={stamina} onChange={(e) => setStamina(Number(e.target.value))}>
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
                <input ref={editFirstInputRef} className="border rounded-md px-3 py-2 w-full" value={editFirst} onChange={(e) => setEditFirst(e.target.value)} />
              </div>

              <div>
                <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Last name</label>
                <input className="border rounded-md px-3 py-2 w-full" value={editLast} onChange={(e) => setEditLast(e.target.value)} />
              </div>

              <div>
                <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Position</label>
                <select className="border rounded-md px-3 py-2 w-full" value={editPos} onChange={(e) => setEditPos(e.target.value as any)}>
                  {positions.map((p) => (
                    <option key={p} value={p}>
                      {positionLabel(p)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Rank</label>
                <select className="border rounded-md px-3 py-2 w-full" value={editRating} onChange={(e) => setEditRating(e.target.value as any)}>
                  {ratings.map((r) => (
                    <option key={r} value={r}>
                      {ratingLabel(r)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block md:hidden text-xs font-medium text-gray-600 mb-1">Stamina level</label>
                <select className="border rounded-md px-3 py-2 w-full" value={editStamina} onChange={(e) => setEditStamina(Number(e.target.value))}>
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
                  const score = computeScore(p);
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
            Score = rating×10 + stamina×2 + positionWeight×3 (DEF=1, MID/FWD/GK=2)
          </div>
        </div>

        {/* Generate Teams */}
        <div className="border rounded-2xl p-5 space-y-4 bg-white shadow-sm mt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-slate-900">Generate Teams (Preview)</div>
              <div className="text-xs text-slate-500 mt-1">
                Generate as many times as you want. Publish replaces any teams already published for this date.
              </div>
            </div>

            <div
              className={`text-xs px-2 py-1 rounded-full border ${
                previewTeams ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-50 text-slate-600 border-slate-200"
              }`}
            >
              {previewTeams ? "Preview ready" : "Not generated"}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
              <input
                type="date"
                className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Number of teams</label>
              <input
                type="number"
                min={2}
                className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
                value={teamCount}
                onChange={(e) => setTeamCount(Number(e.target.value))}
              />

              {selectedGKCount < teamCount && (
                <div className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Note: Only <b>{selectedGKCount}</b> goalkeeper(s) selected for <b>{teamCount}</b> teams.
                </div>
              )}
            </div>

            <div className="flex items-end">
              <div className="flex gap-2 w-full">
                <button className="w-full rounded-lg py-2 font-semibold text-white bg-emerald-600 hover:bg-emerald-700" onClick={generate}>
                  Generate <span className="font-normal opacity-90">(Selected: {selectedIds.length})</span>
                </button>

                <button
                  className={`w-full rounded-lg py-2 font-semibold text-white ${
                    previewTeams ? "bg-sky-600 hover:bg-sky-700" : "bg-slate-300 cursor-not-allowed"
                  }`}
                  onClick={publish}
                  disabled={!previewTeams}
                >
                  Publish
                </button>

                <button
                  className={`w-full rounded-lg py-2 font-semibold text-white ${
                    previewTeams ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-300 cursor-not-allowed"
                  }`}
                  onClick={clearPreview}
                  disabled={!previewTeams}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Delete Published Teams */}
        <div className="border rounded-2xl p-5 space-y-3 bg-white shadow-sm mt-4">
          <div className="font-semibold text-slate-900">Delete Published Teams</div>
          <div className="text-xs text-slate-500">
            Deletes the published teams saved for a specific date (Home page will no longer show them).
          </div>

          {deleteMsg && <div className="text-sm text-blue-700">{deleteMsg}</div>}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
              <input
                type="date"
                className="border rounded-lg px-3 py-2 w-full bg-white"
                value={deleteDate}
                onChange={(e) => setDeleteDate(e.target.value)}
              />
            </div>

            <button
              className="rounded-lg py-2 font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-60"
              onClick={deletePublishedTeams}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting..." : "Delete Published Teams"}
            </button>
          </div>
        </div>

        {/* Preview */}
        {previewTeams && (
          <div className="border rounded-2xl overflow-hidden bg-white shadow-sm mt-4">
            <div className="p-4 bg-gradient-to-r from-slate-50 to-white border-b">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Preview (not published yet)</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Date:{" "}
                    <b>
                      {new Date(previewDate!).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </b>
                  </div>
                </div>

                <div className="text-xs text-slate-500">
                  Tip: If it looks good, click <b>Publish</b>.
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white sticky top-0">
                  <tr className="text-slate-700">
                    <th className="text-left p-3 w-28">Team</th>
                    <th className="text-left p-3">Players</th>
                  </tr>
                </thead>

                <tbody>
                  {previewTeams.map((t: any) => (
                    <tr key={t.teamNumber} className="border-t hover:bg-slate-50 transition">
                      <td className="p-3 font-semibold text-slate-900">#{t.teamNumber}</td>
                      <td className="p-3">
                        <ul className="list-disc pl-5 space-y-1">
                          {t.players.map((p: any) => (
                            <li key={p.id}>
                              {p.firstName} {p.lastName} — <span className="text-slate-600">{positionLabel(p.position)}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
