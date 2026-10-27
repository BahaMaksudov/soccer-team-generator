"use client";

import { useEffect, useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { localKickoff, timeZoneAbbreviation } from "@/lib/deadlineFormat";
import { canonicalAdminMatchPath } from "@/lib/matchPaths";
import { Button } from "@/components/ui/button";
import PlanLimitNotice, { planLimitFrom } from "@/components/billing/PlanLimitNotice";

/**
 * M9-A create-match form (moved from the former CanonicalMatchesSection, same
 * request): date, optional start time and location — sport and timezone come
 * from the Group. Creating a match sends nothing. Opens automatically when the
 * page is reached with #new (Overview "Create match" / "New match").
 *
 * Phase 2 — on a plan with a monthly new-match allowance (Free) it shows
 * "New matches this month: N of 4" and, once used up, why creation is blocked.
 * Display only: POST /matches enforces the allowance on the server.
 */
export type MatchAllowance = { used: number; limit: number | null; exhausted: boolean; message: string | null; resetsAt: string };

const resetLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" });

function AllowanceNote({ allowance, id }: { allowance: MatchAllowance; id: string }) {
  if (allowance.limit === null) return null;
  // Fix A — the shared plan-limit notice (owner: Upgrade to Pro; others: ask the owner).
  return allowance.exhausted ? (
    <div id={id} className="space-y-1">
      <PlanLimitNotice message={`New matches this month: ${allowance.used} of ${allowance.limit}. ${allowance.message ?? ""}`.trim()} />
      <p className="text-sm text-muted-foreground">You can still open, edit and run every existing match. New matches are available again on {resetLabel(allowance.resetsAt)} (UTC).</p>
    </div>
  ) : (
    <p id={id} className="text-sm text-muted-foreground">
      New matches this month: {allowance.used} of {allowance.limit} on the Free plan · resets {resetLabel(allowance.resetsAt)} (UTC)
    </p>
  );
}
export default function CreateMatchForm({
  organizationSlug,
  groupSlug,
  communities = [],
  venues = [],
  allowance = null,
  timezone = "UTC",
}: {
  organizationSlug: string;
  groupSlug: string;
  /** M9.2 — the Group's active Communities; the new Match's roster (required when there are several). */
  communities?: Array<{ id: string; name: string }>;
  /** M9.2 — the Organization's active Venues. */
  venues?: Array<{ id: string; name: string; address: string | null }>;
  /** Phase 2 — the Organization's monthly new-match allowance (null: not shown). */
  allowance?: MatchAllowance | null;
  /** Phase 4B — the Group's timezone (the attendance deadline is entered in it). */
  timezone?: string;
}) {
  const NEW = "__new__";
  const [venueId, setVenueId] = useState("");
  const [newVenue, setNewVenue] = useState({ name: "", address: "" });
  const url = adminTenantApiPath({ organizationSlug, groupSlug, path: "/matches" });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: "", startTime: "", locationName: "", communityId: communities.length === 1 ? communities[0].id : "", attendanceDeadline: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ message: string; plan: string | null } | null>(null);
  const id = useId();
  const blocked = Boolean(allowance?.exhausted);

  useEffect(() => {
    if (window.location.hash === "#new") setOpen(true);
  }, []);
  // Move focus INTO the opened form via its heading — never onto a date/time input: on iOS, focusing one
  // opens its native picker, so the calendar would appear without the user tapping the field.
  useEffect(() => {
    if (open) document.getElementById(`${id}-title`)?.focus();
  }, [open, id]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Phase 4B — same-zone check before the server's full validation (future + before kickoff).
    if (form.attendanceDeadline && form.date && form.attendanceDeadline >= localKickoff(form.date, form.startTime)) {
      setErr("The attendance deadline must be before kickoff.");
      return;
    }
    setBusy(true);
    setLimit(null);
    setErr(null);
    try {
      // M9.2 — "New venue": save it first (Organization-level, reusable), then use it.
      let chosenVenue = venueId && venueId !== NEW ? venueId : "";
      if (venueId === NEW) {
        const vr = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/venues" }), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newVenue.name.trim(), address: newVenue.address.trim() || null }),
        });
        const vd = await vr.json().catch(() => ({}));
        if (!vr.ok) {
          setErr(vd?.issues?.fieldErrors ? (Object.values(vd.issues.fieldErrors).flat()[0] as string) : vd?.error ?? "Could not save the venue.");
          return;
        }
        chosenVenue = vd.venue.id;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: form.date,
          startTime: form.startTime,
          ...(form.locationName ? { locationName: form.locationName } : {}),
          ...(form.communityId ? { communityId: form.communityId } : {}),
          ...(chosenVenue ? { venueId: chosenVenue } : {}),
          ...(form.attendanceDeadline ? { attendanceDeadline: form.attendanceDeadline } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const planLimit = planLimitFrom(data);
        if (planLimit) setLimit(planLimit);
        else setErr(data?.issues?.fieldErrors ? (Object.values(data.issues.fieldErrors).flat()[0] as string) : data?.error ?? "Could not create the match.");
        return;
      }
      window.location.href = canonicalAdminMatchPath(organizationSlug, groupSlug, data.match.id);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" onClick={() => setOpen(true)} disabled={blocked} aria-describedby={allowance?.limit != null ? `${id}-allowance` : undefined}>
          <Plus aria-hidden="true" /> New match
        </Button>
        {allowance && <AllowanceNote allowance={allowance} id={`${id}-allowance`} />}
      </div>
    );
  }

  const input = "h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm";
  return (
    <form id="new" onSubmit={create} aria-labelledby={`${id}-title`} className="w-full scroll-mt-20 space-y-4 rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} tabIndex={-1} className="text-lg font-extrabold focus:outline-none">
          New match
        </h2>
        <Button type="button" variant="ghost" size="icon" aria-label="Close new match form" onClick={() => setOpen(false)}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {communities.length > 0 && (
        <div>
          <label htmlFor={`${id}-community`} className="mb-1 block text-sm font-semibold">Community</label>
          <select id={`${id}-community`} required className={input} value={form.communityId} onChange={(e) => setForm({ ...form, communityId: e.target.value })}>
            {communities.length > 1 && <option value="">Choose a community…</option>}
            {communities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">Attendance, teams and Player of the Match use this community&apos;s players.</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <label htmlFor={`${id}-date`} className="mb-1 block text-sm font-semibold">Date</label>
          <input id={`${id}-date`} type="date" required className={`${input} date-input`} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-time`} className="mb-1 block text-sm font-semibold">Start time <span className="font-normal text-muted-foreground">(optional)</span></label>
          <input id={`${id}-time`} type="time" className={`${input} date-input`} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-venue`} className="mb-1 block text-sm font-semibold">Venue / ground <span className="font-normal text-muted-foreground">(optional)</span></label>
          <select id={`${id}-venue`} className={input} value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">No venue</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            <option value={NEW}>+ New venue…</option>
          </select>
          {venueId && venueId !== NEW && venues.find((v) => v.id === venueId)?.address && (
            <p className="mt-1 text-xs text-muted-foreground">{venues.find((v) => v.id === venueId)!.address}</p>
          )}
        </div>
      </div>
      {venueId === NEW && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div>
            <label htmlFor={`${id}-vname`} className="mb-1 block text-sm font-semibold">Venue name</label>
            <input id={`${id}-vname`} required className={input} maxLength={80} placeholder="ForeKicks" value={newVenue.name} onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-vaddr`} className="mb-1 block text-sm font-semibold">Address <span className="font-normal text-muted-foreground">(for the map link)</span></label>
            <input id={`${id}-vaddr`} className={input} maxLength={200} placeholder="10 Pine Street, Norfolk, MA" value={newVenue.address} onChange={(e) => setNewVenue({ ...newVenue, address: e.target.value })} />
          </div>
        </div>
      )}
      {!venueId && (
        <div>
          <label htmlFor={`${id}-loc`} className="mb-1 block text-sm font-semibold">Location <span className="font-normal text-muted-foreground">(optional, text only)</span></label>
          <input id={`${id}-loc`} className={input} maxLength={80} placeholder="Field 2" value={form.locationName} onChange={(e) => setForm({ ...form, locationName: e.target.value })} />
        </div>
      )}
      <div>
        <label htmlFor={`${id}-deadline`} className="mb-1 block text-sm font-semibold">
          Attendance closes <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id={`${id}-deadline`}
          type="datetime-local"
          className={`${input} date-input sm:max-w-xs`}
          value={form.attendanceDeadline}
          aria-describedby={`${id}-deadline-hint`}
          onChange={(e) => setForm({ ...form, attendanceDeadline: e.target.value })}
        />
        <p id={`${id}-deadline-hint`} className="mt-1 text-xs text-muted-foreground">
          Times in {timezone} ({timeZoneAbbreviation(timezone)}). Leave empty to close attendance yourself. It must be before kickoff.
        </p>
      </div>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      {limit && !allowance?.exhausted && <PlanLimitNotice message={limit.message} plan={limit.plan} />}
      {allowance && <AllowanceNote allowance={allowance} id={`${id}-allowance`} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || blocked} aria-busy={busy}>
          {busy ? "Creating…" : "Create match"}
        </Button>
        <span className="text-xs text-muted-foreground">Creating a match sends nothing.</span>
      </div>
    </form>
  );
}
