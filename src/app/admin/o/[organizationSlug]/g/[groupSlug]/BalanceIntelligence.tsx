"use client";

import type { BalanceAnalysis } from "@/lib/balanceAnalysis";
import type { BalanceMetrics } from "@/lib/balanceEngine";
import { QUALITY_LABEL, describeSwap } from "@/lib/balanceAnalysisUi";
import type { SportClientView } from "@/lib/sports";
import type { GeneratedTeam } from "@/app/admin/types";

/**
 * M8-A — Balance Intelligence for the organizer's preview (admin only).
 * Shows the deterministic quality level, a few sport-labelled facts, and —
 * only when it would make a material difference — the best single swap,
 * which the organizer may apply. Raw numbers stay under "Details".
 */
const QUALITY_STYLE = {
  EVEN: "bg-primary/10 text-primary border-primary/25",
  CLOSE: "bg-secondary text-secondary-foreground border-border",
  UNEVEN: "bg-accent/15 text-accent-foreground border-accent/40",
} as const;

export default function BalanceIntelligence({
  analysis,
  metrics,
  teams,
  sport,
  applying,
  onApplySwap,
}: {
  analysis: BalanceAnalysis;
  metrics: BalanceMetrics | null;
  teams: GeneratedTeam[];
  sport: SportClientView;
  applying: boolean;
  onApplySwap: () => void;
}) {
  const swap = describeSwap(analysis, teams);
  const roleLabel = (key: string) => sport.roles.find((r) => r.key === key)?.label ?? key;
  const rolePlural = (key: string) => sport.roles.find((r) => r.key === key)?.pluralLabel ?? key;

  return (
    <div className="mt-4 space-y-3 rounded-tbp-2xl border border-border bg-card p-4 text-sm shadow-card">
      <div className="flex items-center gap-2">
        <span className="font-display font-extrabold">Balance</span>
        {/* The quality is always written out (never color alone). */}
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${QUALITY_STYLE[analysis.quality]}`}>{QUALITY_LABEL[analysis.quality]}</span>
      </div>

      <ul className="space-y-0.5 text-muted-foreground">
        {analysis.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {swap && (
        <div className="space-y-1 rounded-tbp-xl border border-accent/40 bg-accent/10 p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent-foreground">Suggested improvement</div>
          <div>
            Swap <b>{swap.nameA}</b> (Team {swap.teamA}) with <b>{swap.nameB}</b> (Team {swap.teamB})
          </div>
          <div className="text-xs text-muted-foreground">
            {swap.from} → {swap.to}
          </div>
          <button
            type="button"
            className="inline-flex min-h-9 items-center rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
            disabled={applying}
            onClick={onApplySwap}
          >
            {applying ? "Applying…" : "Apply Swap"}
          </button>
        </div>
      )}

      {metrics && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-primary">Details</summary>
          <div className="overflow-x-auto mt-1">
            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-3">Team</th>
                  <th className="pr-3">Players</th>
                  <th className="pr-3">Strength</th>
                  <th className="pr-3">Skill mix (F/G/VG/E)</th>
                  <th className="pr-3">Avg stamina</th>
                  <th>{sport.terminology.roleNoun}s</th>
                </tr>
              </thead>
              <tbody>
                {metrics.teams.map((t) => (
                  <tr key={t.teamNumber} className="border-t">
                    <td className="pr-3">#{t.teamNumber}</td>
                    <td className="pr-3">{t.size}</td>
                    <td className="pr-3">{t.impactTotal}</td>
                    <td className="pr-3">
                      {t.skillCounts.FAIR}/{t.skillCounts.GOOD}/{t.skillCounts.VERY_GOOD}/{t.skillCounts.EXCELLENT}
                    </td>
                    <td className="pr-3">{t.averageStamina}</td>
                    <td>
                      {Object.entries(t.roleCounts)
                        .map(([k, n]) => `${roleLabel(k)} ${n}`)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 text-gray-500">
            Strength difference between teams: {analysis.impactSpread}. Strength combines skill, stamina and{" "}
            {sport.terminology.roleNoun.toLowerCase()} weights; it is not a skill-level conversion.
          </div>
          {analysis.roleCoverage.map((c) => (
            <div key={c.roleKey} className="text-gray-500">
              {rolePlural(c.roleKey)}: {c.covered} of {metrics.teamCount} teams covered (best possible with this roster: {c.achievable})
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
