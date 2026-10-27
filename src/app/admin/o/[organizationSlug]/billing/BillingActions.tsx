"use client";

import { useState } from "react";
import Link from "next/link";
import { CreditCard, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { US_ONLY_MESSAGE, US_STATES } from "@/lib/billing/usStates";

/**
 * M11.2A / M11.2C — OWNER billing actions (rendered only when billing is
 * enabled and the action is allowed; the server re-checks everything). The
 * browser sends the interval, the US billing address and the Terms agreement;
 * it never chooses a price or an Organization id. The address is validated on
 * the server and stored only on the Stripe Customer (sales tax).
 */
type Address = { line1: string; line2: string; city: string; state: string; postal_code: string };
const EMPTY: Address = { line1: "", line2: "", city: "", state: "", postal_code: "" };

export default function BillingActions({
  organizationSlug,
  canPurchase,
  canManage,
  prices,
  chargeNotices,
  termsHref,
}: {
  organizationSlug: string;
  canPurchase: boolean;
  canManage: boolean;
  prices: { month: string; year: string };
  chargeNotices: { month: string; year: string };
  termsHref: string;
}) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [address, setAddress] = useState<Address>(EMPTY);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const api = (path: string) => `/api/admin/o/${encodeURIComponent(organizationSlug)}/billing${path}`;
  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setAddress((a) => ({ ...a, [k]: e.target.value }));
  const complete = address.line1.trim() && address.city.trim() && address.state && /^\d{5}(-\d{4})?$/.test(address.postal_code.trim());

  async function go(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setErrorField(null);
    try {
      const res = await fetch(api(path), { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string" && data.url.startsWith("https://")) {
        window.location.assign(data.url); // Stripe-hosted page returned by our server
        return;
      }
      setError(data?.error ?? "Something went wrong. Please try again.");
      setErrorField(typeof data?.field === "string" ? data.field : null);
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof Address, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`billing-${k}`}>{label}</Label>
      <Input id={`billing-${k}`} value={address[k]} onChange={set(k)} aria-invalid={errorField === k} {...props} />
    </div>
  );

  return (
    <div className="space-y-3">
      {canPurchase && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void go("/checkout", { interval, address: { ...address, country: "US" }, acceptTerms: accepted });
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Billing period</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Billing period">
              {(["month", "year"] as const).map((i) => (
                <label key={i} className={`flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded-tbp-md border px-3 text-sm ${interval === i ? "border-primary bg-primary/5" : "border-input bg-card"}`}>
                  <span>
                    <span className="block font-semibold">{i === "month" ? "Monthly" : "Annual"}</span>
                    <span className="text-xs text-muted-foreground">{i === "month" ? `${prices.month} per month` : `${prices.year} per year`} + tax where applicable</span>
                  </span>
                  <input type="radio" name="interval" value={i} checked={interval === i} onChange={() => setInterval(i)} className="size-4 accent-[oklch(var(--tbp-primary))]" />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Billing address (United States)</legend>
            <p className="text-xs text-muted-foreground">{US_ONLY_MESSAGE} It&apos;s used to calculate sales tax and is kept by our payment processor, Stripe.</p>
            {field("line1", "Street address", { autoComplete: "address-line1", required: true, maxLength: 100 })}
            {field("line2", "Apartment, suite, etc. (optional)", { autoComplete: "address-line2", maxLength: 100 })}
            <div className="grid gap-3 sm:grid-cols-3">
              {field("city", "City", { autoComplete: "address-level2", required: true, maxLength: 60 })}
              <div className="space-y-1">
                <Label htmlFor="billing-state">State</Label>
                <select
                  id="billing-state"
                  value={address.state}
                  onChange={set("state")}
                  required
                  autoComplete="address-level1"
                  aria-invalid={errorField === "state"}
                  className="flex h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base md:text-sm"
                >
                  <option value="">Choose…</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              {field("postal_code", "ZIP code", { autoComplete: "postal-code", inputMode: "numeric", required: true, maxLength: 10 })}
            </div>
            <p className="text-xs text-muted-foreground">Country: United States</p>
          </fieldset>

          <p className="rounded-tbp-md border border-border bg-secondary p-3 text-xs" data-testid="charge-notice">
            {chargeNotices[interval]}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 size-4" required />
            <span>
              I agree to the{" "}
              <Link href={termsHref} className="underline" target="_blank">
                Terms of Service
              </Link>{" "}
              and authorize this automatically renewing charge until I cancel.
            </span>
          </label>
          <Button type="submit" size="lg" disabled={busy || !accepted || !complete}>
            <CreditCard aria-hidden="true" /> Continue to payment — {interval === "month" ? `${prices.month}/month` : `${prices.year}/year`} + tax where applicable
          </Button>
        </form>
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
