import { Gauge } from "lucide-react";
import type { planSummary } from "@/lib/entitlements";
import { cn } from "@/lib/cn";

/**
 * M11.1 — read-only plan & usage (OWNER/ADMIN). Server-computed by
 * planSummary(); no billing controls until Stripe exists (M11.2).
 */
type Summary = Awaited<ReturnType<typeof planSummary>>;

const ROWS: Array<{ key: keyof Summary["usage"]; label: string }> = [
  { key: "activeGroups", label: "Active groups" },
  { key: "activePlayers", label: "Active players" },
  { key: "monthlyMatches", label: "New matches this month" },
  { key: "activeSchedules", label: "Active recurring schedules" },
  { key: "monthlyAiRecaps", label: "AI recaps this month" },
];

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

export default function PlanUsageCard({ summary }: { summary: Summary }) {
  return (
    <section aria-labelledby="org-plan" className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="org-plan" className="flex items-center gap-2 text-lg font-extrabold">
          <Gauge className="size-5 text-primary" aria-hidden="true" /> Plan &amp; usage
        </h2>
        <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">{summary.label}</span>
      </div>
      {summary.plan === "TRIAL" && summary.trialEndsAt && (
        <p className="mt-2 text-sm">
          Pro trial · <span className="font-semibold">{summary.trialDaysLeft} day{summary.trialDaysLeft === 1 ? "" : "s"} left</span> (ends {dateLabel(summary.trialEndsAt)}). Afterwards the Free plan applies; nothing is charged and no data is removed.
        </p>
      )}
      {summary.plan === "LEGACY" && <p className="mt-2 text-sm text-muted-foreground">Your organization keeps everything it has today while plans are introduced.</p>}
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {ROWS.map(({ key, label }) => {
          const { used, limit } = summary.usage[key];
          const full = limit !== null && used >= limit;
          return (
            <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn("font-semibold tabular-nums", full && "text-destructive")}>
                {limit === null ? `${used} · no limit` : `${used} of ${limit}`}
              </dd>
            </div>
          );
        })}
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5 text-sm">
          <dt className="text-muted-foreground">Telegram integration</dt>
          <dd className="font-semibold">{summary.telegram ? "Included" : "Pro only"}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">Monthly counts reset {dateLabel(summary.resetsAt)} (UTC). Team generation is always unlimited. Reaching a limit never removes data.</p>
    </section>
  );
}
