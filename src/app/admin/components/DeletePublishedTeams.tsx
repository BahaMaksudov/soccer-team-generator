"use client";

import { useState } from "react";

/**
 * Delete Published Teams. Fully self-contained — touches nothing else
 * on the Admin page.
 *
 * IMPORTANT: `deleteDate` is sent to the API as the raw YYYY-MM-DD
 * string from the <input type="date">, exactly as before. It is never
 * round-tripped through `new Date(...)` on this side — the app has
 * previously hit calendar-day-shift bugs doing that, and the server
 * route (`/api/admin/publish` DELETE) already does its own
 * timezone-safe UTC range construction from this same string.
 */
export default function DeletePublishedTeams() {
  const [deleteDate, setDeleteDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

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

  return (
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
  );
}
