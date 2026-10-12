import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { PLAN_LIMITS } from "@/lib/entitlements";
import { PRO_PRICES_USD } from "@/lib/billing/config";

/**
 * M11.2A — Free vs Pro, generated from the SAME catalog the server enforces
 * (PLAN_LIMITS), so the page can never promise something the limits don't allow.
 */
const n = (v: number | null, unit: string) => (v === null ? `Unlimited ${unit}` : `${v} ${unit}`);
const ROWS: Array<{ label: string; free: string | boolean; pro: string | boolean }> = [
  { label: "Active groups", free: String(PLAN_LIMITS.FREE.activeGroups), pro: String(PLAN_LIMITS.PRO.activeGroups) },
  { label: "Active players", free: String(PLAN_LIMITS.FREE.activePlayers), pro: String(PLAN_LIMITS.PRO.activePlayers) },
  { label: "New matches per month", free: n(PLAN_LIMITS.FREE.monthlyMatches, "").trim(), pro: "Unlimited" },
  { label: "Recurring schedules", free: n(PLAN_LIMITS.FREE.activeSchedules, "active").trim(), pro: "Unlimited" },
  { label: "AI match recaps per month", free: String(PLAN_LIMITS.FREE.monthlyAiRecaps), pro: String(PLAN_LIMITS.PRO.monthlyAiRecaps) },
  { label: "Balanced team generation", free: "Unlimited", pro: "Unlimited" },
  { label: "Match link: attendance, teams, results", free: true, pro: true },
  { label: "Telegram integration", free: false, pro: true },
];

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <Check className="mx-auto size-4 text-primary" aria-label="Included" />;
  if (v === false) return <Minus className="mx-auto size-4 text-muted-foreground" aria-label="Not included" />;
  return <span className="font-semibold tabular-nums">{v}</span>;
}

export default function PlanComparison({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-tbp-2xl border border-border bg-card shadow-card", className)}>
      <table className="w-full min-w-[320px] text-sm">
        <caption className="sr-only">Free and Pro plans compared</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="p-3 text-left font-semibold text-muted-foreground">
              Feature
            </th>
            <th scope="col" className="p-3 text-center">
              <span className="block font-display text-base font-extrabold">Free</span>
              <span className="text-xs font-normal text-muted-foreground">$0 forever</span>
            </th>
            <th scope="col" className="p-3 text-center">
              <span className="block font-display text-base font-extrabold text-primary">Pro</span>
              <span className="text-xs font-normal text-muted-foreground">
                {PRO_PRICES_USD.month}/month or {PRO_PRICES_USD.year}/year
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label} className="border-b border-border/60 last:border-0">
              <th scope="row" className="p-3 text-left font-medium">
                {r.label}
              </th>
              <td className="p-3 text-center">
                <Cell v={r.free} />
              </td>
              <td className="p-3 text-center">
                <Cell v={r.pro} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
