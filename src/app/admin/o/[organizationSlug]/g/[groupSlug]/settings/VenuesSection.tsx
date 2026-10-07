"use client";

import { useCallback, useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";

/**
 * M9.2 — the Organization's reusable Venues (shared by all its groups):
 * add, edit name/address, (de)activate. The address powers the map link in
 * Telegram team posts and on match pages. OWNER/ADMIN (APIs answer 404 otherwise).
 */
type Venue = { id: string; name: string; address: string | null; isActive: boolean; mapsUrl: string | null };

export default function VenuesSection({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const url = (path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path });
  const [list, setList] = useState<Venue[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { name: string; address: string }>>({});
  const [draft, setDraft] = useState({ name: "", address: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/venues" }), { cache: "no-store" });
    if (res.ok) setList((await res.json()).venues);
  }, [organizationSlug, groupSlug]);
  useEffect(() => {
    load();
  }, [load]);

  async function send(path: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url(path), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? ok : data?.issues?.fieldErrors ? (Object.values(data.issues.fieldErrors).flat()[0] as string) : data?.error ?? "Something went wrong.");
      await load();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  const input = "h-9 min-w-0 rounded-md border px-2 text-sm";
  return (
    <div className="mt-4 space-y-4 rounded-xl border p-4">
      <p className="text-xs text-muted-foreground">Venues are shared by every group in this organization. The address becomes a map link in Telegram team posts and on match pages.</p>
      {msg && (
        <p role="status" className="text-sm text-blue-700">
          {msg}
        </p>
      )}
      {!list ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No venues yet.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((v) => {
            const e = edit[v.id] ?? { name: v.name, address: v.address ?? "" };
            const changed = e.name.trim() !== v.name || e.address.trim() !== (v.address ?? "");
            return (
              <li key={v.id} className="space-y-2 rounded-lg border p-2">
                <div className="flex flex-wrap gap-2">
                  <input aria-label={`Name of ${v.name}`} className={`${input} flex-1 basis-40`} value={e.name} maxLength={80} onChange={(x) => setEdit({ ...edit, [v.id]: { ...e, name: x.target.value } })} />
                  <input aria-label={`Address of ${v.name}`} className={`${input} flex-[2] basis-56`} value={e.address} maxLength={200} placeholder="Address" onChange={(x) => setEdit({ ...edit, [v.id]: { ...e, address: x.target.value } })} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {v.mapsUrl && (
                    <a className="font-semibold text-primary underline" href={v.mapsUrl} target="_blank" rel="noopener noreferrer">
                      Open map
                    </a>
                  )}
                  {!v.isActive && <span className="text-muted-foreground">Inactive</span>}
                  {changed && (
                    <Button type="button" size="sm" disabled={busy || !e.name.trim()} onClick={() => send(`/venues/${v.id}`, "PATCH", { name: e.name.trim(), address: e.address.trim() || null }, "Venue saved.")}>
                      Save
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => send(`/venues/${v.id}`, "PATCH", { isActive: !v.isActive }, v.isActive ? "Venue deactivated." : "Venue activated.")}>
                    {v.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (await send("/venues", "POST", { name: draft.name.trim(), address: draft.address.trim() || null }, "Venue added.")) setDraft({ name: "", address: "" });
        }}
      >
        <label className="min-w-0 flex-1 basis-40 text-xs font-semibold">
          New venue
          <input className={`${input} mt-1 block w-full font-normal`} value={draft.name} maxLength={80} placeholder="ForeKicks" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="min-w-0 flex-[2] basis-56 text-xs font-semibold">
          Address
          <input className={`${input} mt-1 block w-full font-normal`} value={draft.address} maxLength={200} placeholder="10 Pine Street, Norfolk, MA" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
        </label>
        <Button type="submit" size="sm" disabled={busy || !draft.name.trim()}>
          Add venue
        </Button>
      </form>
    </div>
  );
}
