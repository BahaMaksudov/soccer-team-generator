"use client";

import { useEffect, useMemo, useState } from "react";
import { adminTenantApiPath } from "@/lib/adminTenantApi";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import { roleLabel } from "@/lib/sports";
import { shirtColorOf } from "@/lib/shirtColors";
import { ShirtColorSwatch } from "@/components/teams/ShirtColorBadge";
import type { GeneratedTeam } from "@/app/admin/types";
import type { BalanceAnalysis } from "@/lib/balanceAnalysis";
import type { BalanceMetrics } from "@/lib/balanceEngine";

/**
 * Reuse previous teams (Match workspace, OWNER/ADMIN). Lists this Group's earlier publications,
 * compares one against this Match's CONFIRMED attendees (by player id, server-side) and lets the
 * organizer place every new attendee before the teams go into the normal preview. Nothing here
 * saves or sends anything; the server rebuilds and validates the teams.
 */
type Source = { id: string; date: string; startTime: string | null; locationName: string | null; teamCount: number; playerCount: number; hasShirtColors: boolean };
type Person = { id: string; firstName: string; lastName: string; position: string };
type Plan = {
  source: { id: string; date: string };
  confirmedCount: number;
  teams: Array<{ teamNumber: number; shirtColor: string | null; players: Person[] }>;
  absent: Array<{ id: string; name: string; teamNumber: number }>;
  unassigned: Person[];
};
export type ReuseResult = { date: string; teams: GeneratedTeam[]; reusedFromGenerationId: string; metrics: BalanceMetrics | null; analysis: BalanceAnalysis | null; sourceDate: string };

const players = (n: number) => `${n} player${n === 1 ? "" : "s"}`;
const fieldClass = "h-10 min-w-0 rounded-tbp-sm border border-input bg-card px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm";

export default function ReuseTeamsPanel({
  organizationSlug,
  groupSlug,
  matchId,
  sportKey,
  onUse,
}: {
  organizationSlug: string;
  groupSlug: string;
  matchId: string;
  sportKey: string;
  onUse: (result: ReuseResult) => void;
}) {
  const api = useMemo(() => adminTenantApiPath({ organizationSlug, groupSlug, path: `/matches/${encodeURIComponent(matchId)}/reuse-teams` }), [organizationSlug, groupSlug, matchId]);
  const [sources, setSources] = useState<Source[] | null>(null);
  // The Match's Community (null = a whole-Group match) — the server only lists that scope's publications.
  const [communityName, setCommunityName] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [placements, setPlacements] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(api, { cache: "no-store" })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!live) return;
        if (!ok) return setError(d?.error ?? "Could not load previous teams.");
        setSources(d.sources ?? []);
        setCommunityName(typeof d.communityName === "string" ? d.communityName : null);
      })
      .catch(() => live && setError("Could not load previous teams."));
    return () => {
      live = false;
    };
  }, [api]);

  async function choose(id: string) {
    setSourceId(id);
    setPlan(null);
    setPlacements({});
    setError(null);
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`${api}?source=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d?.error ?? "Could not compare these teams with this match's attendance.");
      else setPlan(d);
    } finally {
      setBusy(false);
    }
  }

  async function use() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: plan.source.id, placements }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d?.error ?? "Could not use these teams.");
        return;
      }
      onUse({ date: d.date, teams: d.teams, reusedFromGenerationId: d.reusedFromGenerationId, metrics: d.metrics ?? null, analysis: d.analysis ?? null, sourceDate: plan.source.date });
    } finally {
      setBusy(false);
    }
  }

  const label = (s: Source) =>
    [formatLongDateOnly(s.date), formatStartTime(s.startTime), s.locationName, `${s.teamCount} teams`, `${s.playerCount} players`, s.hasShirtColors ? null : "no shirt colors"].filter(Boolean).join(" · ");
  const allPlaced = plan ? plan.unassigned.every((p) => placements[p.id] !== undefined) : false;
  const countFor = (n: number) => (plan?.teams.find((t) => t.teamNumber === n)?.players.length ?? 0) + Object.values(placements).filter((v) => v === n).length;
  const returning = plan ? plan.teams.reduce((n, t) => n + t.players.length, 0) : 0;

  return (
    <section aria-labelledby="reuse-teams-title" className="space-y-3 rounded-tbp-xl border border-border bg-background p-3">
      <h3 id="reuse-teams-title" className="font-display font-extrabold">
        Reuse teams from a previous match
      </h3>
      {error && (
        <p role="alert" className="rounded-tbp-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {sources === null && !error && <p className="text-sm text-muted-foreground">Loading previous teams…</p>}
      {sources !== null && (
        <p className="text-xs text-muted-foreground" data-testid="reuse-scope">
          {communityName ? (
            <>
              Only teams published for <b>{communityName}</b> matches are listed.
            </>
          ) : (
            "Only teams published for whole-group matches (no community) are listed."
          )}
        </p>
      )}
      {sources?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {communityName ? `${communityName} has` : "This group has"} no earlier published teams yet. Generate new balanced teams instead — once teams are published, you can reuse them for a later match.
        </p>
      )}
      {sources && sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="reuse-source" className="text-xs font-semibold">
            Previous teams (newest first)
          </label>
          <select id="reuse-source" className={`${fieldClass} w-full`} value={sourceId} onChange={(e) => choose(e.target.value)} disabled={busy}>
            <option value="">Choose a previous match…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
      )}

      {plan && (
        <div className="space-y-3">
          <ul className="flex flex-wrap gap-2 text-xs font-semibold" aria-label="Roster comparison">
            <li className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">{returning} returning</li>
            <li className="rounded-full bg-muted px-2.5 py-1">{plan.absent.length} not playing this time</li>
            <li className="rounded-full bg-accent/15 px-2.5 py-1">{plan.unassigned.length} new this time</li>
            <li className="rounded-full bg-muted px-2.5 py-1">{plan.confirmedCount} confirmed for this match</li>
          </ul>

          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Reused teams">
            {plan.teams.map((t) => {
              const color = shirtColorOf(t.shirtColor);
              const added = plan.unassigned.filter((p) => placements[p.id] === t.teamNumber);
              return (
                <li key={t.teamNumber} className="min-w-0 rounded-tbp-sm border border-border p-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm font-bold">
                    {color && <ShirtColorSwatch color={color.id} />}
                    Team #{t.teamNumber}
                    {color && <span className="-ml-1 font-semibold">— {color.label} Shirts</span>}
                    <span className="ml-auto text-xs font-medium text-muted-foreground">{players(countFor(t.teamNumber))}</span>
                  </div>
                  <ul className="space-y-0.5 text-sm">
                    {t.players.map((p) => (
                      <li key={p.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {p.firstName} {p.lastName}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{roleLabel(sportKey, p.position)}</span>
                      </li>
                    ))}
                    {added.map((p) => (
                      <li key={p.id} className="flex justify-between gap-2 font-semibold text-primary">
                        <span className="truncate">
                          {p.firstName} {p.lastName} <span className="text-xs font-medium">(new)</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{roleLabel(sportKey, p.position)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>

          {plan.absent.length > 0 && (
            <div className="text-sm">
              <p className="font-semibold">Not playing this time (left out)</p>
              <p className="text-muted-foreground">{plan.absent.map((p) => `${p.name} (was Team #${p.teamNumber})`).join(", ")}</p>
            </div>
          )}

          {plan.unassigned.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">New this time — choose a team for each player</legend>
              {plan.unassigned.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`reuse-place-${p.id}`} className="min-w-0 flex-1 text-sm">
                    {p.firstName} {p.lastName} <span className="text-xs text-muted-foreground">· {roleLabel(sportKey, p.position)}</span>
                  </label>
                  <select
                    id={`reuse-place-${p.id}`}
                    className={`${fieldClass} w-full sm:w-56`}
                    value={placements[p.id] ?? ""}
                    onChange={(e) =>
                      setPlacements((cur) => {
                        const next = { ...cur };
                        if (e.target.value) next[p.id] = Number(e.target.value);
                        else delete next[p.id];
                        return next;
                      })
                    }
                  >
                    <option value="">Choose a team…</option>
                    {plan.teams.map((t) => (
                      <option key={t.teamNumber} value={t.teamNumber}>
                        Team #{t.teamNumber}
                        {shirtColorOf(t.shirtColor) ? ` — ${shirtColorOf(t.shirtColor)!.label}` : ""} ({players(countFor(t.teamNumber))})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex min-h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || !allPlaced}
              onClick={use}
            >
              Use these teams
            </button>
            {!allPlaced && <span className="text-xs text-muted-foreground">Place every new player on a team first.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
