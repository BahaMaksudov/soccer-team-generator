"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, RefreshCw } from "lucide-react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { WEEKDAYS } from "@/lib/scheduleTime";
import { Button } from "@/components/ui/button";
import { SectionCard, StateChip } from "@/components/game-day/parts";
import Dialog from "@/components/app/Dialog";
import { runFeedback, type Feedback, type RunResult } from "@/lib/automationFeedback";

/**
 * M9.2 — weekly recurring matches (OWNER/ADMIN). Automation creates each Match
 * and posts its attendance poll at the poll time, closes attendance at the
 * cutoff and emails organizers. Teams are never generated or published by it.
 *
 * M9.2.1 — each schedule card shows its automation state with Run now (the
 * same engine as the scheduler; works while paused without resuming it),
 * Pause / Resume automation (MatchSchedule.isActive; existing Matches are
 * untouched) and Edit.
 */
type Schedule = {
  id: string;
  communityId: string;
  communityName: string;
  venueId: string | null;
  venueName: string | null;
  timezone: string;
  weekday: number;
  startTime: string;
  pollDaysBefore: number;
  pollTime: string;
  cutoffDaysBefore: number;
  cutoffTime: string;
  isActive: boolean;
  next: { gameDate: string; gameAt: string; pollAt: string; cutoffAt: string };
};
type Form = Omit<Schedule, "id" | "communityName" | "venueName" | "isActive" | "next"> & { venueId: string };

const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const daysLabel = (n: number) => (n === 0 ? "same day" : n === 1 ? "1 day before" : `${n} days before`);
const gameDay = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
/** "21:00" → "9:00 PM". */
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** Weekday + time of a step that happens `daysBefore` the game weekday. */
const stepAt = (weekday: number, daysBefore: number, hhmm: string) => `${WEEKDAYS[(weekday - daysBefore + 7) % 7]} ${clock(hhmm)}`;

export default function SchedulesSection({
  organizationSlug,
  groupSlug,
  communities,
  venues,
  defaultTimezone,
}: {
  organizationSlug: string;
  groupSlug: string;
  communities: Array<{ id: string; name: string }>;
  venues: Array<{ id: string; name: string }>;
  defaultTimezone: string;
}) {
  const url = (path: string) => adminTenantApiPath({ organizationSlug, groupSlug, path });
  const [list, setList] = useState<Schedule[] | null>(null);
  const [form, setForm] = useState<{ mode: "new" } | { mode: "edit"; id: string } | null>(null);
  const empty: Form = { communityId: communities.length === 1 ? communities[0].id : "", venueId: "", timezone: defaultTimezone, weekday: 1, startTime: "21:00", pollDaysBefore: 1, pollTime: "20:00", cutoffDaysBefore: 0, cutoffTime: "20:00" };
  const [values, setValues] = useState<Form>(empty);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [confirmPause, setConfirmPause] = useState<Schedule | null>(null);

  async function runNow(id: string) {
    setBusy(true);
    setFeedback((f) => ({ ...f, [id]: { tone: "done", text: "Running…" } }));
    try {
      const res = await fetch(url(`/schedules/${id}/run`), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setFeedback((f) => ({ ...f, [id]: res.ok ? runFeedback(data as RunResult) : { tone: "warn", text: data?.error ?? "Automation could not run. Please try again." } }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setActive(s: Schedule, isActive: boolean) {
    setConfirmPause(null);
    setBusy(true);
    try {
      const res = await fetch(url(`/schedules/${s.id}`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
      const data = await res.json().catch(() => ({}));
      setFeedback((f) => ({
        ...f,
        [s.id]: res.ok
          ? { tone: "done", text: isActive ? "Automation resumed. The next due poll and cutoff will run automatically." : "Automation paused. Existing matches are unchanged." }
          : { tone: "warn", text: data?.error ?? "Something went wrong." },
      }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/schedules" }), { cache: "no-store" });
    if (res.ok) setList((await res.json()).schedules);
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

  const input = "h-10 w-full rounded-tbp-md border border-input bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const daysSelect = (value: number, onChange: (n: number) => void, label: string) => (
    <select aria-label={label} className={input} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {[0, 1, 2, 3, 4, 5, 6].map((n) => (
        <option key={n} value={n}>
          {daysLabel(n)}
        </option>
      ))}
    </select>
  );

  return (
    <SectionCard
      id="schedules"
      title="Recurring matches"
      icon={<CalendarClock className="size-5" />}
      action={
        !form && communities.length > 0 ? (
          <Button type="button" size="sm" variant="outline" onClick={() => (setValues(empty), setForm({ mode: "new" }))}>
            <Plus aria-hidden="true" /> New schedule
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        Automation creates each match, posts the attendance poll to the community&apos;s Telegram group, closes attendance at the cutoff and emails organizers when it&apos;s ready. Teams are always generated and published by you.
      </p>
      {communities.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Create a community first (Group settings → Communities).</p>}
      {msg && (
        <p role="status" className="mt-3 rounded-tbp border border-border bg-secondary px-3 py-2 text-sm">
          {msg}
        </p>
      )}

      {form && (
        <form
          className="mt-4 space-y-3 rounded-tbp-xl border border-border p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const body = { ...values, venueId: values.venueId || null };
            const ok = form.mode === "new" ? await send("/schedules", "POST", body, "Schedule created.") : await send(`/schedules/${form.id}`, "PATCH", body, "Schedule saved.");
            if (ok) setForm(null);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm font-semibold">
              Community
              <select required className={`${input} mt-1`} value={values.communityId} onChange={(e) => setValues({ ...values, communityId: e.target.value })}>
                <option value="">Choose…</option>
                {communities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Venue <span className="font-normal text-muted-foreground">(optional)</span>
              <select className={`${input} mt-1`} value={values.venueId} onChange={(e) => setValues({ ...values, venueId: e.target.value })}>
                <option value="">No venue</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Time zone
              <input className={`${input} mt-1`} value={values.timezone} onChange={(e) => setValues({ ...values, timezone: e.target.value })} placeholder="America/New_York" />
            </label>
            <label className="text-sm font-semibold">
              Game day
              <select className={`${input} mt-1`} value={values.weekday} onChange={(e) => setValues({ ...values, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    Every {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Game time
              <input type="time" required className={`${input} mt-1`} value={values.startTime} onChange={(e) => setValues({ ...values, startTime: e.target.value })} />
            </label>
            <div />
            <fieldset className="text-sm font-semibold">
              <legend>Send attendance poll</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {daysSelect(values.pollDaysBefore, (n) => setValues({ ...values, pollDaysBefore: n }), "Poll: days before the game")}
                <input type="time" aria-label="Poll time" required className={input} value={values.pollTime} onChange={(e) => setValues({ ...values, pollTime: e.target.value })} />
              </div>
            </fieldset>
            <fieldset className="text-sm font-semibold">
              <legend>Attendance cutoff</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {daysSelect(values.cutoffDaysBefore, (n) => setValues({ ...values, cutoffDaysBefore: n }), "Cutoff: days before the game")}
                <input type="time" aria-label="Cutoff time" required className={input} value={values.cutoffTime} onChange={(e) => setValues({ ...values, cutoffTime: e.target.value })} />
              </div>
            </fieldset>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {form.mode === "new" ? "Create schedule" : "Save schedule"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Changes apply to matches created from now on.</p>
        </form>
      )}

      {list && list.length > 0 && (
        <ul className="mt-4 space-y-3">
          {list.map((s) => {
            const fb = feedback[s.id];
            return (
              <li key={s.id} className="rounded-tbp-xl border border-border p-3 text-sm sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-extrabold">{s.communityName}</h3>
                    <p className="text-muted-foreground">
                      Every {WEEKDAYS[s.weekday]} · {clock(s.startTime)}
                      {s.venueName ? ` · ${s.venueName}` : ""}
                    </p>
                  </div>
                  <StateChip tone={s.isActive ? "done" : "neutral"}>Automation: {s.isActive ? "Enabled" : "Paused"}</StateChip>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Poll</dt>
                    <dd className="font-semibold">{stepAt(s.weekday, s.pollDaysBefore, s.pollTime)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Cutoff</dt>
                    <dd className="font-semibold">{stepAt(s.weekday, s.cutoffDaysBefore, s.cutoffTime)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Next game</dt>
                    <dd className="font-semibold">{gameDay(s.next.gameAt, s.timezone)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Next poll</dt>
                    <dd className="font-semibold">{s.isActive ? when(s.next.pollAt, s.timezone) : "Paused"}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">Times in {s.timezone}.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={busy} onClick={() => runNow(s.id)}>
                    <RefreshCw aria-hidden="true" /> Run Now
                  </Button>
                  {s.isActive ? (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmPause(s)}>
                      <Pause aria-hidden="true" /> Pause Automation
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setActive(s, true)}>
                      <Play aria-hidden="true" /> Resume Automation
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      const { communityId, venueId, timezone, weekday, startTime, pollDaysBefore, pollTime, cutoffDaysBefore, cutoffTime } = s;
                      setValues({ communityId, venueId: venueId ?? "", timezone, weekday, startTime, pollDaysBefore, pollTime, cutoffDaysBefore, cutoffTime });
                      setForm({ mode: "edit", id: s.id });
                    }}
                  >
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                </div>
                {fb && (
                  <div role="status" className={`mt-3 rounded-tbp border px-3 py-2 ${fb.tone === "warn" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-border bg-secondary"}`}>
                    <p>{fb.text}</p>
                    {fb.details && (
                      <ul className="mt-1 list-disc pl-5">
                        {fb.details.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={confirmPause !== null} title="Pause automation for this recurring schedule?" onClose={() => setConfirmPause(null)}>
        <p className="text-sm text-muted-foreground">Upcoming automatic poll and attendance processing will not run until you resume it. Existing matches, attendance, polls and results are not changed, and you can still use Run Now.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setConfirmPause(null)}>
            Keep running
          </Button>
          <Button type="button" onClick={() => confirmPause && setActive(confirmPause, false)}>
            Pause automation
          </Button>
        </div>
      </Dialog>
    </SectionCard>
  );
}
