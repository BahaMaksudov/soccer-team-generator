"use client";

import { useState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * M11.2A — OWNER billing actions (rendered only when billing is enabled and
 * the action is allowed; the server re-checks everything). The browser sends
 * only the interval; it never chooses a price or an Organization id.
 */
export default function BillingActions({
  organizationSlug,
  canPurchase,
  canManage,
  prices,
  chargeNotice,
}: {
  organizationSlug: string;
  canPurchase: boolean;
  canManage: boolean;
  prices: { month: string; year: string };
  chargeNotice: string;
}) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = (path: string) => `/api/admin/o/${encodeURIComponent(organizationSlug)}/billing${path}`;

  async function go(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api(path), { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string" && data.url.startsWith("https://")) {
        window.location.assign(data.url); // Stripe-hosted page returned by our server
        return;
      }
      setError(data?.error ?? "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {canPurchase && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Billing period</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Billing period">
            {(["month", "year"] as const).map((i) => (
              <label key={i} className={`flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded-tbp-md border px-3 text-sm ${interval === i ? "border-primary bg-primary/5" : "border-input bg-card"}`}>
                <span>
                  <span className="block font-semibold">{i === "month" ? "Monthly" : "Annual"}</span>
                  <span className="text-xs text-muted-foreground">{i === "month" ? `${prices.month} per month` : `${prices.year} per year`}</span>
                </span>
                <input type="radio" name="interval" value={i} checked={interval === i} onChange={() => setInterval(i)} className="size-4 accent-[oklch(var(--tbp-primary))]" />
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{chargeNotice}</p>
          <Button type="button" size="lg" disabled={busy} onClick={() => go("/checkout", { interval })}>
            <CreditCard aria-hidden="true" /> Upgrade to Pro — {interval === "month" ? `${prices.month}/month` : `${prices.year}/year`}
          </Button>
        </fieldset>
      )}
      {canManage && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => go("/portal")}>
          <ExternalLink aria-hidden="true" /> Manage billing
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
