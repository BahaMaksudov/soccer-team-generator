"use client";

import { useCallback, useEffect, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { GEOCODING_ATTRIBUTION } from "@/lib/weatherLegal";

/**
 * M9.2 — the Organization's reusable Venues (shared by all its groups):
 * add, edit name/address, (de)activate. The address powers the map link in
 * Telegram team posts and on match pages. OWNER/ADMIN (APIs answer 404 otherwise).
 *
 * Phase 4B — Indoor flag, and the venue's WEATHER LOCATION: search (city /
 * ZIP / address) → the organizer explicitly chooses one result → confirm.
 * Nothing is stored before confirming; replace / remove anytime; changing the
 * address clears it. Geocoding attribution is shown next to locations.
 */
type Venue = {
  id: string;
  name: string;
  address: string | null;
  isActive: boolean;
  mapsUrl: string | null;
  isIndoor?: boolean;
  weatherLocation?: { label: string; confirmedAt: string } | null;
};
type Candidate = { label: string; city: string | null; region: string | null; country: string | null; postcode: string | null; token: string };

function GeoAttribution() {
  const { provider, data } = GEOCODING_ATTRIBUTION;
  return (
    <span className="text-[11px] text-muted-foreground">
      {provider.before}{" "}
      <a className="underline" href={provider.url} target="_blank" rel="noopener noreferrer">
        {provider.text}
      </a>{" "}
      · {data.before}{" "}
      <a className="underline" href={data.url} target="_blank" rel="noopener noreferrer">
        {data.text}
      </a>
    </span>
  );
}

export default function VenuesSection({ organizationSlug, groupSlug }: { organizationSlug: string; groupSlug: string }) {
  const url = (path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path });
  const [list, setList] = useState<Venue[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { name: string; address: string }>>({});
  const [draft, setDraft] = useState({ name: "", address: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Phase 4B — the open location search (one venue at a time).
  const [locate, setLocate] = useState<{ venueId: string; query: string; candidates: Candidate[] | null; choice: string; error: string | null } | null>(null);

  async function searchLocation() {
    if (!locate || locate.query.trim().length < 2) return;
    setBusy(true);
    try {
      const res = await fetch(url(`/venues/${locate.venueId}/weather-location/search`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: locate.query.trim() }) });
      const data = await res.json().catch(() => ({}));
      setLocate({ ...locate, candidates: res.ok ? data.candidates : null, choice: "", error: res.ok ? (data.candidates.length ? null : "No matching places. Try a city, ZIP / postal code or a fuller address.") : data?.issues?.fieldErrors ? (Object.values(data.issues.fieldErrors).flat()[0] as string) : data?.error ?? "Search failed." });
    } finally {
      setBusy(false);
    }
  }

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
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !e.name.trim()}
                      onClick={() =>
                        send(
                          `/venues/${v.id}`,
                          "PATCH",
                          { name: e.name.trim(), address: e.address.trim() || null },
                          v.weatherLocation && e.address.trim() !== (v.address ?? "") ? "Venue saved. The address changed, so confirm its weather location again." : "Venue saved."
                        )
                      }
                    >
                      Save
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => send(`/venues/${v.id}`, "PATCH", { isActive: !v.isActive }, v.isActive ? "Venue deactivated." : "Venue activated.")}>
                    {v.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <label className="inline-flex min-h-9 items-center gap-1.5 font-semibold">
                    <input type="checkbox" className="size-4" checked={Boolean(v.isIndoor)} disabled={busy} onChange={(x) => send(`/venues/${v.id}`, "PATCH", { isIndoor: x.target.checked }, x.target.checked ? "Marked as an indoor venue." : "Marked as an outdoor venue.")} />
                    Indoor venue
                  </label>
                </div>
                {/* Phase 4B — weather location (used only for Game Day Update forecasts). */}
                <div className="space-y-1 rounded-md bg-muted/40 p-2 text-xs">
                  {v.weatherLocation ? (
                    <p>
                      <span className="text-muted-foreground">Weather location:</span> <span className="font-semibold">{v.weatherLocation.label}</span> <GeoAttribution />
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No weather location — Game Day Updates for this venue have no forecast.</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setLocate({ venueId: v.id, query: v.address ?? "", candidates: null, choice: "", error: null })}>
                      {v.weatherLocation ? "Replace location" : "Set weather location"}
                    </Button>
                    {v.weatherLocation && (
                      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => send(`/venues/${v.id}/weather-location`, "DELETE", {}, "Weather location removed.")}>
                        Remove location
                      </Button>
                    )}
                  </div>
                  {locate?.venueId === v.id && (
                    <div className="space-y-2 border-t border-border pt-2" role="group" aria-label={`Weather location for ${v.name}`}>
                      <div className="flex flex-wrap gap-2">
                        <label className="sr-only" htmlFor={`loc-${v.id}`}>
                          City, ZIP / postal code or address
                        </label>
                        <input
                          id={`loc-${v.id}`}
                          className={`${input} w-full flex-1 basis-56`}
                          value={locate.query}
                          maxLength={200}
                          placeholder="City, ZIP / postal code or address"
                          onChange={(x) => setLocate({ ...locate, query: x.target.value })}
                          onKeyDown={(x) => {
                            if (x.key === "Enter") {
                              x.preventDefault();
                              searchLocation();
                            }
                          }}
                        />
                        <Button type="button" size="sm" disabled={busy || locate.query.trim().length < 2} onClick={searchLocation}>
                          Search
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setLocate(null)}>
                          Cancel
                        </Button>
                      </div>
                      {locate.error && (
                        <p role="alert" className="text-destructive">
                          {locate.error}
                        </p>
                      )}
                      {locate.candidates && locate.candidates.length > 0 && (
                        <fieldset className="space-y-1">
                          <legend className="font-semibold">Choose the right place:</legend>
                          {locate.candidates.map((c) => (
                            <label key={c.token} className="flex items-start gap-2 rounded-md border bg-card p-2">
                              <input type="radio" name={`loc-choice-${v.id}`} className="mt-0.5" checked={locate.choice === c.token} onChange={() => setLocate({ ...locate, choice: c.token })} />
                              <span className="min-w-0">
                                <span className="block break-words font-semibold">{c.label}</span>
                                <span className="block text-muted-foreground">{[c.city, c.region, c.country].filter(Boolean).join(", ")}</span>
                              </span>
                            </label>
                          ))}
                          <GeoAttribution />
                          <div>
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy || !locate.choice}
                              onClick={async () => {
                                if (await send(`/venues/${v.id}/weather-location`, "POST", { candidate: locate.choice }, "Weather location confirmed.")) setLocate(null);
                              }}
                            >
                              Confirm this location
                            </Button>
                          </div>
                        </fieldset>
                      )}
                    </div>
                  )}
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
