"use client";

import { useEffect, useMemo, useState } from "react";
import { timeZoneOptions } from "@/lib/timeZoneOptions";

type Sport = { key: string; label: string };

function firstError(data: unknown): string {
  const d = data as { error?: string; issues?: { fieldErrors?: Record<string, string[]> } };
  const field = d?.issues?.fieldErrors && Object.values(d.issues.fieldErrors).flat()[0];
  return field || d?.error || "Could not create the group. Please try again.";
}

/** M7 — Add Group (name, sport, timezone). The server re-validates everything. */
export default function AddGroupForm({
  organizationSlug,
  sports,
  defaultTimezone,
}: {
  organizationSlug: string;
  sports: Sport[];
  defaultTimezone: string;
}) {
  const [groupName, setGroupName] = useState("");
  const [sportKey, setSportKey] = useState(sports[0]?.key ?? "");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setTimezone(tz);
    } catch {
      // keep default
    }
  }, []);
  const zones = useMemo(() => timeZoneOptions(timezone), [timezone]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/o/${encodeURIComponent(organizationSlug)}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupName, sportKey, timezone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.href !== "string") {
        setErr(res.status === 401 ? "Your session has expired. Please sign in again." : firstError(data));
        setLoading(false);
        return;
      }
      window.location.href = data.href;
    } catch {
      setErr("Could not create the group. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {err && <div className="text-sm text-red-600" role="alert">{err}</div>}
      <div>
        <label className="block text-sm mb-1" htmlFor="groupName">Group name</label>
        <input id="groupName" className="w-full border rounded-md px-3 py-2" value={groupName}
          onChange={(e) => setGroupName(e.target.value)} placeholder="Tuesday Basketball" maxLength={80} required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-sm mb-1" htmlFor="sportKey">Sport</label>
          <select id="sportKey" className="w-full border rounded-md px-3 py-2 bg-white" value={sportKey}
            onChange={(e) => setSportKey(e.target.value)}>
            {sports.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">Sport can&apos;t be changed later.</p>
        </div>
        <div>
          <label className="block text-sm mb-1" htmlFor="timezone">Timezone</label>
          <select id="timezone" className="w-full border rounded-md px-3 py-2 bg-white" value={timezone}
            onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" className="w-full bg-black text-white rounded-md py-2 disabled:opacity-60" disabled={loading}>
        {loading ? "Creating..." : "Create group"}
      </button>
    </form>
  );
}
