"use client";

import { useId, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import PlanLimitNotice, { planLimitFrom } from "@/components/billing/PlanLimitNotice";
import type { GameDayUpdateSettings, GameDayUpdateView } from "@/lib/gameDayUpdateSettings";

/**
 * Phase 4B (step 4) — Telegram Game Day Update settings (OWNER/ADMIN; the page
 * and the API are organizer-only). Settings only: the reminder itself and its
 * weather come in later steps. On a plan without Telegram the controls are
 * disabled with the existing upgrade explanation (the server refuses turning
 * it on); turning it OFF stays possible.
 */
const HOURS: GameDayUpdateSettings["hoursBefore"][] = [2, 4, 6, 12];
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const field = "h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:w-64 md:text-sm";

function Switch({ id, checked, disabled, onChange, labelledBy, describedBy }: { id: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; labelledBy: string; describedBy?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", checked ? "bg-primary" : "bg-muted-foreground/30", focusRing)}
    >
      <span className={cn("inline-block size-5 rounded-full bg-card shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} aria-hidden="true" />
    </button>
  );
}

export default function GameDayUpdateSection({ organizationSlug, groupSlug, initial }: { organizationSlug: string; groupSlug: string; initial: GameDayUpdateView }) {
  const id = useId();
  const [saved, setSaved] = useState<GameDayUpdateSettings>(initial.settings);
  const [v, setV] = useState<GameDayUpdateSettings>(initial.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // Fix A — a 402 PLAN_LIMIT (Telegram is a Pro capability) gets the shared notice; other errors keep msg.
  const [limit, setLimit] = useState<{ message: string; plan: string | null } | null>(null);
  const available = initial.telegramAvailable;
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  // Without Telegram in the plan nothing can be turned on; a stored "on" can still be turned off.
  const locked = !available && !v.enabled && !saved.enabled;

  async function save() {
    setBusy(true);
    setMsg(null);
    setLimit(null);
    try {
      const res = await fetch(adminTenantApiPath({ organizationSlug, groupSlug, path: "/settings/game-day-update" }), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaved(data.settings);
        setV(data.settings);
        setMsg({ tone: "ok", text: data.settings.enabled ? "Game Day Update settings saved." : "Saved. Game Day Updates are off." });
      } else if (planLimitFrom(data)) {
        setLimit(planLimitFrom(data));
      } else {
        setMsg({ tone: "error", text: data?.issues?.fieldErrors ? (Object.values(data.issues.fieldErrors).flat()[0] as string) : data?.error ?? "Could not save the settings." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-tbp-2xl border border-border bg-card p-4 shadow-card sm:p-5" aria-labelledby={`${id}-title`} role="group">
      <h3 id={`${id}-title`} className="text-lg font-extrabold">
        Game Day Update
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A reminder posted in the match&apos;s Telegram group, as a reply to its attendance poll, before attendance closes — with kickoff, venue, players confirmed, the time left and (optionally) the weather. It&apos;s sent at most once per match.
      </p>
      {!available && initial.planMessage && <PlanLimitNotice className="mt-3" message={initial.planMessage} />}

      <div className="mt-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={`${id}-enabled-label`} className="font-semibold">
              Send a Game Day Update in Telegram
            </p>
            <p id={`${id}-enabled-hint`} className="text-xs text-muted-foreground">
              Off by default. Only for matches with an attendance deadline and an attendance poll posted to Telegram.
            </p>
          </div>
          <Switch id={`${id}-enabled`} checked={v.enabled} disabled={busy || (!available && !v.enabled)} onChange={(enabled) => setV({ ...v, enabled })} labelledBy={`${id}-enabled-label`} describedBy={`${id}-enabled-hint`} />
        </div>

        <fieldset disabled={busy || locked} className="space-y-4 disabled:opacity-80">
          <legend className="sr-only">Game Day Update preferences</legend>
          <div>
            <label htmlFor={`${id}-hours`} className="block text-sm font-semibold">
              When to send it
            </label>
            <select id={`${id}-hours`} className={cn(field, "mt-1")} value={v.hoursBefore} aria-describedby={`${id}-hours-hint`} onChange={(e) => setV({ ...v, hoursBefore: Number(e.target.value) as GameDayUpdateSettings["hoursBefore"] })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} hours before attendance closes
                </option>
              ))}
            </select>
            <p id={`${id}-hours-hint`} className="mt-1 text-xs text-muted-foreground">
              Timed from the match&apos;s attendance closing time — not from kickoff.
            </p>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p id={`${id}-weather-label`} className="font-semibold">
                Include the weather forecast
              </p>
              <p id={`${id}-weather-hint`} className="text-xs text-muted-foreground">
                Needs a confirmed weather location on the match&apos;s venue (Venues). Indoor venues show the outside weather.
              </p>
            </div>
            <Switch id={`${id}-weather`} checked={v.includeWeather} disabled={busy || locked} onChange={(includeWeather) => setV({ ...v, includeWeather })} labelledBy={`${id}-weather-label`} describedBy={`${id}-weather-hint`} />
          </div>

          <div>
            <label htmlFor={`${id}-units`} className="block text-sm font-semibold">
              Weather units
            </label>
            <select id={`${id}-units`} className={cn(field, "mt-1")} value={v.units} onChange={(e) => setV({ ...v, units: e.target.value as GameDayUpdateSettings["units"] })}>
              <option value="imperial">°F and mph</option>
              <option value="metric">°C and km/h</option>
            </select>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} disabled={busy || !dirty || (!available && v.enabled)}>
            {busy ? "Saving…" : "Save Game Day Update settings"}
          </Button>
          {limit && <PlanLimitNotice className="w-full" message={limit.message} plan={limit.plan} />}
          {msg && (
            <p role={msg.tone === "error" ? "alert" : "status"} aria-live="polite" className={cn("text-sm", msg.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
              {msg.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
