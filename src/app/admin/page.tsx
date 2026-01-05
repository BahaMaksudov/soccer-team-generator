"use client";

import { useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { positionLabel, ratingLabel } from "@/lib/labels";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
  rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  isActive: boolean;
};

const positions = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"] as const;
const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;

export default function AdminPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [teamCount, setTeamCount] = useState(2);
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState<string | null>(null);

  const [previewTeams, setPreviewTeams] = useState<any[] | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [position, setPosition] = useState<Player["position"]>("MIDFIELDER");
  const [rating, setRating] = useState<Player["rating"]>("GOOD");

  const [editId, setEditId] = useState<string | null>(null);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editPos, setEditPos] = useState<Player["position"]>("MIDFIELDER");
  const [editRating, setEditRating] = useState<Player["rating"]>("GOOD");

  // ✅ Step 5 states (MUST be inside component)
  const [teamName, setTeamName] = useState("");
  const [teamNameSaving, setTeamNameSaving] = useState(false);

  async function loadPlayers() {
    setMsg(null);
    const res = await fetch("/api/admin/players", { cache: "no-store" });
    if (!res.ok) {
      setMsg("You must be logged in as admin.");
      return;
    }
    const data = await res.json();
    setPlayers(data);
  }

  // ✅ load players + team name once
  useEffect(() => {
  loadPlayers();

  (async () => {
    try {
      const res = await fetch("/api/admin/settings/team-name", { cache: "no-store" });

      if (!res.ok) {
        const text = await res.text();
        console.log("TEAM NAME GET failed:", res.status, text);
        return;
      }

      const data = await res.json();
      console.log("TEAM NAME GET ok:", data);
    } catch (e) {
      console.log("TEAM NAME GET error:", e);
    }
  })();
}, []);

  // useEffect(() => {
  //   loadPlayers();

  //   (async () => {
  //     const res = await fetch("/api/admin/settings/team-name", { cache: "no-store" });
  //     if (res.ok) {
  //       const data = await res.json();
  //       setTeamName(data.teamName || "");
  //     }
  //   })();
  // }, []);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
    [selected]
  );

  const selectedGKCount = useMemo(() => {
    const sel = new Set(selectedIds);
    return players.filter((p) => sel.has(p.id) && p.position === "GOALKEEPER" && p.isActive).length;
  }, [players, selectedIds]);

  async function addPlayer() {
    setMsg(null);
    if (!firstName.trim() || !lastName.trim()) {
      setMsg("Please enter first name and last name.");
      return;
    }
    const res = await fetch("/api/admin/players", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, position, rating, isActive: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(data?.error ?? "Failed to add player");
      return;
    }
    setFirstName("");
    setLastName("");
    await loadPlayers();
    setMsg("✅ Player saved.");
  }

  function openEdit(p: Player) {
    setEditId(p.id);
    setEditFirst(p.firstName);
    setEditLast(p.lastName);
    setEditPos(p.position);
    setEditRating(p.rating);
  }

  async function saveEdit() {
    if (!editId) return;
    setMsg(null);
    const res = await fetch(`/api/admin/players/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: editFirst,
        lastName: editLast,
        position: editPos,
        rating: editRating,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(data?.error ?? "Failed to update player");
      return;
    }
    setEditId(null);
    await loadPlayers();
    setMsg("✅ Player updated.");
  }

  async function toggleActive(p: Player) {
    const res = await fetch(`/api/admin/players/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !p.isActive }),
    });
    if (!res.ok) setMsg("Failed to update player");
    await loadPlayers();
  }

  async function deletePlayer(id: string) {
    const ok = confirm("Delete this player?");
    if (!ok) return;
    const res = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
    if (!res.ok) setMsg("Failed to delete player");
    await loadPlayers();
  }

  async function generate() {
    setMsg(null);
    const res = await fetch("/api/admin/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamCount, date: new Date(date).toISOString(), selectedIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data?.error ?? "Failed to generate");
      return;
    }
    setPreviewTeams(data.teams);
    setPreviewDate(data.date);
    setMsg("Preview generated. If it looks good, click Publish. You can regenerate multiple times.");
  }

  async function publish() {
    setMsg(null);
    if (!previewTeams || !previewDate) {
      setMsg("Generate teams first, then publish.");
      return;
    }
    const res = await fetch("/api/admin/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: previewDate, teams: previewTeams }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data?.error ?? "Failed to publish");
      return;
    }
    setMsg("✅ Published! Home page updated for that date (previous teams replaced).");
  }

  function clearPreview() {
    setPreviewTeams(null);
    setPreviewDate(null);
    setMsg("Preview cleared.");
  }

  // ✅ Step 5 save handler
  async function saveTeamName() {
    setMsg(null);
    const name = teamName.trim();
    if (!name) {
      setMsg("Team name is required.");
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
      setMsg(data?.error ?? "Failed to update team name");
      return;
    }
    setTeamName(data.teamName || name);
    setMsg("✅ Team name updated. Refresh Home page to see it.");
  }

  return (
    <div className="space-y-6">
      {/* Page background card */}
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <button className="text-sm underline ml-auto" onClick={() => signOut({ callbackUrl: "/" })}>
            Sign out
          </button>
        </div>

        {msg && <div className="text-sm text-blue-700">{msg}</div>}

        {/* ✅ Step 5 UI (Team Settings) */}
        <div className="border rounded-xl p-4 bg-white space-y-3">
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

        <div className="border rounded-xl p-4 space-y-3 bg-white">
          <div className="font-semibold">Add Player</div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <input
              className="border rounded-md px-3 py-2"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
            <input
              className="border rounded-md px-3 py-2"
              placeholder="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
            <select className="border rounded-md px-3 py-2" value={position} onChange={(e) => setPosition(e.target.value as any)}>
              {positions.map((p) => (
                <option key={p} value={p}>
                  {positionLabel(p)}
                </option>
              ))}
            </select>
            <select className="border rounded-md px-3 py-2" value={rating} onChange={(e) => setRating(e.target.value as any)}>
              {ratings.map((r) => (
                <option key={r} value={r}>
                  {ratingLabel(r)}
                </option>
              ))}
            </select>
            <button className="bg-black text-white rounded-md py-2" onClick={addPlayer}>
              Save
            </button>
          </div>
          <div className="text-xs text-gray-500">Ratings are only visible to admin. Public pages show name + position.</div>
        </div>

        {editId && (
          <div className="border rounded-xl p-4 bg-white space-y-3">
            <div className="font-semibold">Edit Player</div>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <input className="border rounded-md px-3 py-2" value={editFirst} onChange={(e) => setEditFirst(e.target.value)} />
              <input className="border rounded-md px-3 py-2" value={editLast} onChange={(e) => setEditLast(e.target.value)} />
              <select className="border rounded-md px-3 py-2" value={editPos} onChange={(e) => setEditPos(e.target.value as any)}>
                {positions.map((p) => (
                  <option key={p} value={p}>
                    {positionLabel(p)}
                  </option>
                ))}
              </select>
              <select className="border rounded-md px-3 py-2" value={editRating} onChange={(e) => setEditRating(e.target.value as any)}>
                {ratings.map((r) => (
                  <option key={r} value={r}>
                    {ratingLabel(r)}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <button className="bg-black text-white rounded-md px-4" onClick={saveEdit}>
                  Save
                </button>
                <button className="border rounded-md px-4" onClick={() => setEditId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="border rounded-xl overflow-hidden bg-white">
          <div className="p-4 font-semibold">Players (select for team generation)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="p-3 text-left w-10">Sel</th>
                  <th className="p-3 text-left">Name</th>
                  <th className="p-3 text-left">Position</th>
                  <th className="p-3 text-left">Rating</th>
                  <th className="p-3 text-left">Active</th>
                  <th className="p-3 text-left w-40">Actions</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
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
                ))}
                {players.length === 0 && (
                  <tr>
                    <td className="p-3 text-gray-500" colSpan={6}>
                      No players yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Your Generate Teams UI (unchanged) */}
        <div className="border rounded-2xl p-5 space-y-4 bg-white shadow-sm">
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
                  Note: Only <b>{selectedGKCount}</b> goalkeeper(s) selected for <b>{teamCount}</b> teams. (1 GK per team not possible.)
                </div>
              )}
            </div>

            <div className="flex items-end">
              <div className="flex gap-2 w-full">
                <button
                  className="w-full rounded-lg py-2 font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] transition"
                  onClick={generate}
                >
                  Generate <span className="font-normal opacity-90">(Selected: {selectedIds.length})</span>
                </button>

                <button
                  className={`w-full rounded-lg py-2 font-semibold text-white transition ${
                    previewTeams ? "bg-sky-600 hover:bg-sky-700 active:scale-[0.99]" : "bg-slate-300 cursor-not-allowed"
                  }`}
                  onClick={publish}
                  disabled={!previewTeams}
                >
                  Publish
                </button>

                <button
                  className={`w-full rounded-lg py-2 font-semibold text-white transition ${
                    previewTeams ? "bg-rose-600 hover:bg-rose-700 active:scale-[0.99]" : "bg-slate-300 cursor-not-allowed"
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

        {previewTeams && (
          <div className="border rounded-2xl overflow-hidden bg-white shadow-sm">
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


// "use client";

// import { useEffect, useMemo, useState } from "react";
// import { signOut } from "next-auth/react";
// import { positionLabel, ratingLabel } from "@/lib/labels";

// type Player = {
//   id: string;
//   firstName: string;
//   lastName: string;
//   position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
//   rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
//   isActive: boolean;
// };

// const positions = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"] as const;
// const ratings = ["FAIR", "GOOD", "VERY_GOOD", "EXCELLENT"] as const;


// export default function AdminPage() {
//   const [players, setPlayers] = useState<Player[]>([]);
//   const [selected, setSelected] = useState<Record<string, boolean>>({});

//   const [teamCount, setTeamCount] = useState(2);
//   const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
//   const [msg, setMsg] = useState<string | null>(null);

//   const [previewTeams, setPreviewTeams] = useState<any[] | null>(null);
//   const [previewDate, setPreviewDate] = useState<string | null>(null);

//   const [firstName, setFirstName] = useState("");
//   const [lastName, setLastName] = useState("");
//   const [position, setPosition] = useState<Player["position"]>("MIDFIELDER");
//   const [rating, setRating] = useState<Player["rating"]>("GOOD");

//   const [editId, setEditId] = useState<string | null>(null);
//   const [editFirst, setEditFirst] = useState("");
//   const [editLast, setEditLast] = useState("");
//   const [editPos, setEditPos] = useState<Player["position"]>("MIDFIELDER");
//   const [editRating, setEditRating] = useState<Player["rating"]>("GOOD");

//   async function loadPlayers() {
//     setMsg(null);
//     const res = await fetch("/api/admin/players", { cache: "no-store" });
//     if (!res.ok) {
//       setMsg("You must be logged in as admin.");
//       return;
//     }
//     const data = await res.json();
//     setPlayers(data);
//   }

//   useEffect(() => { loadPlayers(); }, []);


//   const selectedIds = useMemo(
//     () => Object.entries(selected).filter(([, v]) => v).map(([id]) => id),
//     [selected]
//   );

//   const selectedGKCount = useMemo(() => {
//     const sel = new Set(selectedIds);
//     return players.filter((p) => sel.has(p.id) && p.position === "GOALKEEPER" && p.isActive).length;
//   }, [players, selectedIds]);

//   async function addPlayer() {
//     setMsg(null);
//     if (!firstName.trim() || !lastName.trim()) {
//       setMsg("Please enter first name and last name.");
//       return;
//     }
//     const res = await fetch("/api/admin/players", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ firstName, lastName, position, rating, isActive: true }),
//     });
//     const data = await res.json().catch(() => ({}));
//     if (!res.ok) {
//       setMsg(data?.error ?? "Failed to add player");
//       return;
//     }
//     setFirstName(""); setLastName("");
//     await loadPlayers();
//     setMsg("✅ Player saved.");
//   }

//   function openEdit(p: Player) {
//     setEditId(p.id);
//     setEditFirst(p.firstName);
//     setEditLast(p.lastName);
//     setEditPos(p.position);
//     setEditRating(p.rating);
//   }

//   async function saveEdit() {
//     if (!editId) return;
//     setMsg(null);
//     const res = await fetch(`/api/admin/players/${editId}`, {
//       method: "PATCH",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ firstName: editFirst, lastName: editLast, position: editPos, rating: editRating }),
//     });
//     const data = await res.json().catch(() => ({}));
//     if (!res.ok) {
//       setMsg(data?.error ?? "Failed to update player");
//       return;
//     }
//     setEditId(null);
//     await loadPlayers();
//     setMsg("✅ Player updated.");
//   }

//   async function toggleActive(p: Player) {
//     const res = await fetch(`/api/admin/players/${p.id}`, {
//       method: "PATCH",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ isActive: !p.isActive }),
//     });
//     if (!res.ok) setMsg("Failed to update player");
//     await loadPlayers();
//   }

//   async function deletePlayer(id: string) {
//     const ok = confirm("Delete this player?");
//     if (!ok) return;
//     const res = await fetch(`/api/admin/players/${id}`, { method: "DELETE" });
//     if (!res.ok) setMsg("Failed to delete player");
//     await loadPlayers();
//   }

//   async function generate() {
//     setMsg(null);
//     const res = await fetch("/api/admin/generate", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ teamCount, date: new Date(date).toISOString(), selectedIds }),
//     });
//     const data = await res.json();
//     if (!res.ok) {
//       setMsg(data?.error ?? "Failed to generate");
//       return;
//     }
//     setPreviewTeams(data.teams);
//     setPreviewDate(data.date);
//     setMsg("Preview generated. If it looks good, click Publish. You can regenerate multiple times.");
//   }

//   async function publish() {
//     setMsg(null);
//     if (!previewTeams || !previewDate) {
//       setMsg("Generate teams first, then publish.");
//       return;
//     }
//     const res = await fetch("/api/admin/publish", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ date: previewDate, teams: previewTeams }),
//     });
//     const data = await res.json();
//     if (!res.ok) {
//       setMsg(data?.error ?? "Failed to publish");
//       return;
//     }
//     setMsg("✅ Published! Home page updated for that date (previous teams replaced).");
//   }

//   function clearPreview() {
//     setPreviewTeams(null);
//     setPreviewDate(null);
//     setMsg("Preview cleared.");
//   }

//   return (
//     <div className="space-y-6">
//       {/* Page background card */}
//     <div className="rounded-2xl border bg-white shadow-sm p-5">
//       <div className="flex items-center gap-3">
//         <h1 className="text-2xl font-semibold">Admin</h1>
//         <button className="text-sm underline ml-auto" onClick={() => signOut({ callbackUrl: "/" })}>
//           Sign out
//         </button>
//       </div>

//       {msg && <div className="text-sm text-blue-700">{msg}</div>}

//       <div className="border rounded-xl p-4 space-y-3 bg-white">
//         <div className="font-semibold">Add Player</div>
//         <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
//           <input className="border rounded-md px-3 py-2" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
//           <input className="border rounded-md px-3 py-2" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
//           <select className="border rounded-md px-3 py-2" value={position} onChange={(e) => setPosition(e.target.value as any)}>
//             {positions.map((p) => <option key={p} value={p}>{positionLabel(p)}</option>)}
//           </select>
//           <select className="border rounded-md px-3 py-2" value={rating} onChange={(e) => setRating(e.target.value as any)}>
//             {ratings.map((r) => <option key={r} value={r}>{ratingLabel(r)}</option>)}
//           </select>
//           <button className="bg-black text-white rounded-md py-2" onClick={addPlayer}>Save</button>
//         </div>
//         <div className="text-xs text-gray-500">Ratings are only visible to admin. Public pages show name + position.</div>
//       </div>

//       {editId && (
//         <div className="border rounded-xl p-4 bg-white space-y-3">
//           <div className="font-semibold">Edit Player</div>
//           <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
//             <input className="border rounded-md px-3 py-2" value={editFirst} onChange={(e) => setEditFirst(e.target.value)} />
//             <input className="border rounded-md px-3 py-2" value={editLast} onChange={(e) => setEditLast(e.target.value)} />
//             <select className="border rounded-md px-3 py-2" value={editPos} onChange={(e) => setEditPos(e.target.value as any)}>
//               {positions.map((p) => <option key={p} value={p}>{positionLabel(p)}</option>)}
//             </select>
//             <select className="border rounded-md px-3 py-2" value={editRating} onChange={(e) => setEditRating(e.target.value as any)}>
//               {ratings.map((r) => <option key={r} value={r}>{ratingLabel(r)}</option>)}
//             </select>
//             <div className="flex gap-2">
//               <button className="bg-black text-white rounded-md px-4" onClick={saveEdit}>Save</button>
//               <button className="border rounded-md px-4" onClick={() => setEditId(null)}>Cancel</button>
//             </div>
//           </div>
//         </div>
//       )}

//       <div className="border rounded-xl overflow-hidden bg-white">
//         <div className="p-4 font-semibold">Players (select for team generation)</div>
//         <div className="overflow-x-auto">
//           <table className="w-full text-sm">
//             <thead className="bg-gray-50">
//               <tr>
//                 <th className="p-3 text-left w-10">Sel</th>
//                 <th className="p-3 text-left">Name</th>
//                 <th className="p-3 text-left">Position</th>
//                 <th className="p-3 text-left">Rating</th>
//                 <th className="p-3 text-left">Active</th>
//                 <th className="p-3 text-left w-40">Actions</th>
//               </tr>
//             </thead>
//             <tbody>
//               {players.map((p) => (
//                 <tr key={p.id} className="border-t">
//                   <td className="p-3">
//                     <input type="checkbox" checked={!!selected[p.id]} onChange={(e) => setSelected((s) => ({ ...s, [p.id]: e.target.checked }))} disabled={!p.isActive} />
//                   </td>
//                   <td className="p-3">{p.firstName} {p.lastName}</td>
//                   <td className="p-3 text-gray-700">{positionLabel(p.position)}</td>
//                   <td className="p-3">{ratingLabel(p.rating)}</td>
//                   <td className="p-3">
//                     <button className="underline" onClick={() => toggleActive(p)}>
//                       {p.isActive ? "Yes" : "No"}
//                     </button>
//                   </td>
//                   <td className="p-3">
//                     <div className="flex gap-3">
//                       <button className="underline" onClick={() => openEdit(p)}>Edit</button>
//                       <button className="text-red-700 underline" onClick={() => deletePlayer(p.id)}>Delete</button>
//                     </div>
//                   </td>
//                 </tr>
//               ))}
//               {players.length === 0 && (
//                 <tr><td className="p-3 text-gray-500" colSpan={6}>No players yet.</td></tr>
//               )}
//             </tbody>
//           </table>
//         </div>
//       </div>

//       {/* <div className="border rounded-xl p-4 space-y-3 bg-white">
//         <div className="font-semibold">Generate Teams (Preview)</div>
//         <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
//           <div>
//             <label className="block text-sm mb-1">Date</label>
//             <input type="date" className="border rounded-md px-3 py-2 w-full" value={date} onChange={(e) => setDate(e.target.value)} />
//           </div>
//           <div>
//             <label className="block text-sm mb-1">Number of teams</label>
//             <input type="number" min={2} className="border rounded-md px-3 py-2 w-full" value={teamCount} onChange={(e) => setTeamCount(Number(e.target.value))} />
//             {selectedGKCount < teamCount && (
//               <div className="text-xs text-orange-700 mt-1">
//                 Note: Only {selectedGKCount} goalkeeper(s) selected for {teamCount} teams. (1 GK per team not possible.)
//               </div>
//             )}
//           </div>
//           <div className="flex items-end">
//             <div className="flex gap-2 w-full">
//               <button className="bg-black text-white rounded-md py-2 w-full" onClick={generate}>
//                 Generate (Selected: {selectedIds.length})
//               </button>
//               <button className={`border rounded-md py-2 w-full ${!previewTeams ? "opacity-50 cursor-not-allowed" : ""}`} onClick={publish} disabled={!previewTeams}>
//                 Publish
//               </button>
//               <button className={`border rounded-md py-2 w-full ${!previewTeams ? "opacity-50 cursor-not-allowed" : ""}`} onClick={clearPreview} disabled={!previewTeams}>
//                 Clear
//               </button>
//             </div>
//           </div>
//         </div>
//         <div className="text-xs text-gray-500">Generate as many times as you want. Publish replaces any already published teams for that same date.</div>
//       </div> */}

// <div className="border rounded-2xl p-5 space-y-4 bg-white shadow-sm">
//   <div className="flex items-start justify-between gap-3">
//     <div>
//       <div className="font-semibold text-slate-900">Generate Teams (Preview)</div>
//       <div className="text-xs text-slate-500 mt-1">
//         Generate as many times as you want. Publish replaces any teams already published for this date.
//       </div>
//     </div>

//     <div
//       className={`text-xs px-2 py-1 rounded-full border ${
//         previewTeams
//           ? "bg-emerald-50 text-emerald-700 border-emerald-200"
//           : "bg-slate-50 text-slate-600 border-slate-200"
//       }`}
//     >
//       {previewTeams ? "Preview ready" : "Not generated"}
//     </div>
//   </div>

//   <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
//     <div>
//       <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
//       <input
//         type="date"
//         className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
//         value={date}
//         onChange={(e) => setDate(e.target.value)}
//       />
//     </div>

//     <div>
//       <label className="block text-sm font-medium text-slate-700 mb-1">Number of teams</label>
//       <input
//         type="number"
//         min={2}
//         className="border rounded-lg px-3 py-2 w-full bg-white focus:outline-none focus:ring-2 focus:ring-emerald-200"
//         value={teamCount}
//         onChange={(e) => setTeamCount(Number(e.target.value))}
//       />

//       {selectedGKCount < teamCount && (
//         <div className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
//           Note: Only <b>{selectedGKCount}</b> goalkeeper(s) selected for <b>{teamCount}</b> teams. (1 GK per team not possible.)
//         </div>
//       )}
//     </div>

//     <div className="flex items-end">
//       <div className="flex gap-2 w-full">
//         {/* Generate: GREEN */}
//         <button
//           className="
//             w-full rounded-lg py-2 font-semibold text-white
//             bg-emerald-600 hover:bg-emerald-700
//             active:scale-[0.99]
//             transition
//           "
//           onClick={generate}
//         >
//           Generate <span className="font-normal opacity-90">(Selected: {selectedIds.length})</span>
//         </button>

//         {/* Publish: BLUE */}
//         <button
//           className={`
//             w-full rounded-lg py-2 font-semibold text-white transition
//             ${previewTeams
//               ? "bg-sky-600 hover:bg-sky-700 active:scale-[0.99]"
//               : "bg-slate-300 cursor-not-allowed"}
//           `}
//           onClick={publish}
//           disabled={!previewTeams}
//         >
//           Publish
//         </button>

//         {/* Clear: RED */}
//         <button
//           className={`
//             w-full rounded-lg py-2 font-semibold text-white transition
//             ${previewTeams
//               ? "bg-rose-600 hover:bg-rose-700 active:scale-[0.99]"
//               : "bg-slate-300 cursor-not-allowed"}
//           `}
//           onClick={clearPreview}
//           disabled={!previewTeams}
//         >
//           Clear
//         </button>
//       </div>
//     </div>
//   </div>
// </div>
// {previewTeams && (
//   <div className="border rounded-2xl overflow-hidden bg-white shadow-sm">
//     <div className="p-4 bg-gradient-to-r from-slate-50 to-white border-b">
//       <div className="flex items-start justify-between gap-3">
//         <div>
//           <div className="font-semibold text-slate-900">Preview (not published yet)</div>
//           <div className="text-xs text-slate-500 mt-1">
//             Date:{" "}
//             <b>
//               {new Date(previewDate!).toLocaleDateString(undefined, {
//                 year: "numeric",
//                 month: "long",
//                 day: "numeric",
//               })}
//             </b>
//           </div>
//         </div>

//         <div className="text-xs text-slate-500">
//           Tip: If it looks good, click <b>Publish</b>.
//         </div>
//       </div>
//     </div>

//     <div className="overflow-x-auto">
//       <table className="w-full text-sm">
//         <thead className="bg-white sticky top-0">
//           <tr className="text-slate-700">
//             <th className="text-left p-3 w-28">Team</th>
//             <th className="text-left p-3">Players</th>
//           </tr>
//         </thead>

//         <tbody>
//           {previewTeams.map((t: any) => (
//             <tr key={t.teamNumber} className="border-t hover:bg-slate-50 transition">
//               <td className="p-3 font-semibold text-slate-900">#{t.teamNumber}</td>
//               <td className="p-3">
//                 <ul className="list-disc pl-5 space-y-1">
//                   {t.players.map((p: any) => (
//                     <li key={p.id}>
//                       {p.firstName} {p.lastName} —{" "}
//                       <span className="text-slate-600">{positionLabel(p.position)}</span>
//                     </li>
//                   ))}
//                 </ul>
//               </td>
//             </tr>
//           ))}
//         </tbody>
//       </table>
//     </div>
//   </div>
// )}
//       {/* {previewTeams && (
//         <div className="border rounded-xl overflow-hidden bg-white">
//           <div className="p-4 bg-gray-50 border-b">
//             <div className="font-semibold">Preview (not published yet)</div>
//             <div className="text-xs text-gray-500">
//               Date: {new Date(previewDate!).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
//             </div>
//           </div>
//           <div className="overflow-x-auto">
//             <table className="w-full text-sm">
//               <thead className="bg-white">
//                 <tr><th className="text-left p-3 w-28">Team</th><th className="text-left p-3">Players</th></tr>
//               </thead>
//               <tbody>
//                 {previewTeams.map((t: any) => (
//                   <tr key={t.teamNumber} className="border-t">
//                     <td className="p-3 font-semibold">#{t.teamNumber}</td>
//                     <td className="p-3">
//                       <ul className="list-disc pl-5 space-y-1">
//                         {t.players.map((p: any) => (
//                           <li key={p.id}>
//                             {p.firstName} {p.lastName} — <span className="text-gray-600">{positionLabel(p.position)}</span>
//                           </li>
//                         ))}
//                       </ul>
//                     </td>
//                   </tr>
//                 ))}
//               </tbody>
//             </table>
//           </div>
//         </div>
//       )} */}
//     </div>
//     </div>
//   );
// }
