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
      {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="groupName">Group name</label>
        <input id="groupName" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" value={groupName}
          onChange={(e) => setGroupName(e.target.value)} placeholder="Tuesday Basketball" maxLength={80} required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="sportKey">Sport</label>
          <select id="sportKey" aria-describedby="sportKey-hint" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base md:text-sm" value={sportKey}
            onChange={(e) => setSportKey(e.target.value)}>
            {sports.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <p id="sportKey-hint" className="mt-1 text-xs text-muted-foreground">Sport can&apos;t be changed later.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-semibold" htmlFor="timezone">Timezone</label>
          <select id="timezone" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base md:text-sm" value={timezone}
            onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60" disabled={loading} aria-busy={loading}>
        {loading ? "Creating..." : "Create group"}
      </button>
    </form>
  );
}
