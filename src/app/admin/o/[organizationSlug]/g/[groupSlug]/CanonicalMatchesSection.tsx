"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import type { MatchSummary } from "@/lib/matches";

/**
 * M9-A — Matches of this Group: upcoming / past, and "+ New match" (date,
 * optional start time and location; sport and timezone come from the Group).
 * Several matches may share a date. Creating a match sends nothing.
 */
export default function CanonicalMatchesSection({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const url = adminTenantApiPath({ organizationSlug, groupSlug, path: "/matches" });
  const [lists, setLists] = useState<{ upcoming: MatchSummary[]; past: MatchSummary[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ date: "", startTime: "", locationName: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) setLists(await res.json());
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug, groupSlug]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.issues?.fieldErrors ? Object.values(data.issues.fieldErrors).flat()[0] as string : data?.error ?? "Could not create the match.");
        return;
      }
      window.location.href = `/admin/o/${encodeURIComponent(organizationSlug)}/g/${encodeURIComponent(groupSlug)}/matches/${encodeURIComponent(data.match.id)}`;
    } finally {
      setBusy(false);
    }
  }

  const row = (m: MatchSummary) => (
    <li key={m.id} className="flex flex-wrap items-center gap-2">
      <Link className="underline" href={`/admin/o/${encodeURIComponent(organizationSlug)}/g/${encodeURIComponent(groupSlug)}/matches/${encodeURIComponent(m.id)}`}>
        {formatLongDateOnly(m.date)}
        {m.startTime ? ` · ${formatStartTime(m.startTime)}` : ""}
      </Link>
      {m.locationName && <span className="text-gray-600">{m.locationName}</span>}
      {m.status !== "SCHEDULED" && <span className="text-xs border rounded-full px-2">{m.status === "CANCELED" ? "Canceled" : "Completed"}</span>}
    </li>
  );

  return (
    <div className="border rounded-xl p-4 mt-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Matches</div>
        <button type="button" className="text-sm underline" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "+ New match"}
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="flex flex-wrap items-end gap-2 text-sm">
          <div>
            <label className="block text-xs">Date</label>
            <input type="date" required className="border rounded px-2 py-1" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs">Start time (optional)</label>
            <input type="time" className="border rounded px-2 py-1" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs">Location (optional)</label>
            <input className="border rounded px-2 py-1" maxLength={80} placeholder="Field 2" value={form.locationName} onChange={(e) => setForm({ ...form, locationName: e.target.value })} />
          </div>
          <button type="submit" disabled={busy} className="bg-black text-white rounded px-3 py-1 disabled:opacity-60">
            {busy ? "Creating…" : "Create match"}
          </button>
          {err && <div className="w-full text-rose-700">{err}</div>}
        </form>
      )}

      {!lists ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1">Upcoming</div>
            {lists.upcoming.length === 0 ? <div className="text-gray-500">No upcoming matches.</div> : <ul className="space-y-1">{lists.upcoming.map(row)}</ul>}
          </div>
          <div>
            <div className="text-xs font-medium text-gray-500 mb-1">Past / completed</div>
            {lists.past.length === 0 ? <div className="text-gray-500">None yet.</div> : <ul className="space-y-1">{lists.past.slice(0, 10).map(row)}</ul>}
          </div>
        </div>
      )}
    </div>
  );
}
