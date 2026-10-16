import Link from "next/link";
import { Gauge } from "lucide-react";
import type { planSummary } from "@/lib/entitlements";
import { cn } from "@/lib/cn";

/**
 * M11.1 — read-only plan & usage (OWNER/ADMIN). Server-computed by
 * planSummary(); no billing controls until Stripe exists (M11.2).
 * M11.3 — after the trial: when it ended, why Telegram is off, that nothing was
 * deleted; "Upgrade to Pro" only when billing is on and the viewer may upgrade
 * (`upgradeHref`), otherwise the honest "coming soon" hint.
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

export default function PlanUsageCard({ summary, upgradeHref = null }: { summary: Summary; upgradeHref?: string | null }) {
  const isFree = summary.plan === "FREE" || summary.plan === "TRIAL";
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
      {summary.plan === "FREE" && summary.trialEndedAt && (
        <p className="mt-2 text-sm">
          Your Pro trial ended on <span className="font-semibold">{dateLabel(summary.trialEndedAt)}</span>. On the Free plan, Telegram polls, team posts, match messages and Game Day Updates are off; players can still answer through the match link. Nothing was deleted — players, matches, history and connected Telegram groups are kept.
        </p>
      )}
      {isFree && (upgradeHref && summary.billingEnabled ? (
        <p className="mt-3">
          <Link href={upgradeHref} className="inline-flex h-9 items-center rounded-tbp-sm bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Upgrade to Pro
          </Link>
        </p>
      ) : (
        !summary.billingEnabled && summary.upgradeHint && <p className="mt-2 text-sm text-muted-foreground">{summary.upgradeHint}</p>
      ))}
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
