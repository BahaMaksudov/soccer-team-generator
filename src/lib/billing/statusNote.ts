/**
 * M11.2B — the Billing page's subscription status line (pure; unit-tested).
 *
 * Stripe schedules a cancellation in two ways: a cancel_at date (what the
 * Customer Portal sets — cancel_at_period_end stays false — and what a
 * Dashboard cancellation on a chosen date sets) or cancel_at_period_end.
 * Either way the subscription stays "active" (so Pro stays, status-based)
 * until Stripe actually ends it; the page must then say when access ends,
 * never "renews".
 */
export type StatusNote = { tone: "ok" | "info" | "warn"; text: string };
export type SubscriptionView = {
  status: string;
  interval: string | null;
  currentPeriodEnd: string | null;
  accessEndsAt: string | null;
  endedAt: string | null;
};

/** When a scheduled cancellation takes effect (null = renewing, or already ended). */
export function scheduledEnd(sub: { status: string; cancelAt: Date | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null }): Date | null {
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return null;
  return sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null);
}

// Billing dates are shown in UTC (Stripe's instants; the server runs in UTC).
export const billingDateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const INTERVAL_LABEL: Record<string, string> = { month: "monthly", year: "annual" };

export function billingStatusNote(sub: SubscriptionView | null): StatusNote | null {
  if (!sub) return null;
  if (sub.status === "past_due") return { tone: "warn", text: "Your last payment failed. Stripe is retrying — update your payment method in Manage billing to keep Pro." };
  if (sub.status === "unpaid") return { tone: "warn", text: "Pro ended because payment didn't go through. Your data is kept; Free limits apply." };
  if (sub.status === "incomplete") return { tone: "warn", text: "Your payment is still pending. Pro starts once it's confirmed." };
  if (sub.status === "canceled") return { tone: "info", text: `Your Pro subscription ended${sub.endedAt ? ` on ${billingDateLabel(sub.endedAt)}` : ""}. Your data is kept; Free limits apply.` };
  if (sub.accessEndsAt) return { tone: "info", text: `Pro access ends on ${billingDateLabel(sub.accessEndsAt)}. You can resume your subscription before then.` };
  if ((sub.status === "active" || sub.status === "trialing") && sub.currentPeriodEnd) return { tone: "ok", text: `Pro (${INTERVAL_LABEL[sub.interval ?? ""] ?? "subscription"}) renews on ${billingDateLabel(sub.currentPeriodEnd)}.` };
  return null;
}
