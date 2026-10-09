import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CreditCard } from "lucide-react";
import { requireOrganizationContextForSlug, TenantContextError, type OrganizationContext } from "@/lib/tenantContext";
import { billingView, CHECKOUT_CHARGE_NOTICE, confirmCheckoutReturn } from "@/lib/billing/checkout";
import PlanUsageCard from "../PlanUsageCard";
import PlanComparison from "@/components/billing/PlanComparison";
import BillingActions from "./BillingActions";

/**
 * M11.2A — Organization billing (Stripe TEST MODE).
 * OWNER: plan & usage, Free vs Pro, monthly/annual, Upgrade (when eligible),
 * Manage billing (Stripe Customer Portal). ADMIN: read-only status.
 * MEMBER / foreign: the generic 404. LEGACY / COMP: explained, no purchase.
 * The ?checkout=success return is verified with Stripe on the server — the
 * URL alone activates nothing.
 */
type Params = Promise<{ organizationSlug: string }>;
type Search = Promise<{ checkout?: string; session_id?: string }>;

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const INTERVAL_LABEL: Record<string, string> = { month: "monthly", year: "annual" };

export const dynamic = "force-dynamic";

export default async function BillingPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { organizationSlug } = await params;
  const sp = await searchParams;
  let context: OrganizationContext;
  try {
    context = await requireOrganizationContextForSlug({ organizationSlug });
  } catch (e) {
    if (e instanceof TenantContextError) {
      if (e.code === "EMAIL_NOT_VERIFIED") redirect("/verify-email");
      notFound();
    }
    throw e;
  }
  const returned = sp.checkout === "success" ? await confirmCheckoutReturn(context, sp.session_id) : null;
  const view = await billingView(context);
  if (!view) notFound();
  const { summary, subscription: sub } = view;
  const orgBase = `/admin/o/${encodeURIComponent(context.organization.slug)}`;

  const statusNote = (() => {
    if (!sub) return null;
    if (sub.status === "past_due") return { tone: "warn", text: "Your last payment failed. Stripe is retrying — update your payment method in Manage billing to keep Pro." };
    if (sub.status === "unpaid") return { tone: "warn", text: "Pro ended because payment didn't go through. Your data is kept; Free limits apply." };
    if (sub.status === "incomplete") return { tone: "warn", text: "Your payment is still pending. Pro starts once it's confirmed." };
    if (sub.status === "canceled") return { tone: "info", text: `Your Pro subscription ended${sub.endedAt ? ` on ${dateLabel(sub.endedAt)}` : ""}. Your data is kept; Free limits apply.` };
    if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd) return { tone: "info", text: `Pro is canceled and stays active until ${dateLabel(sub.currentPeriodEnd)}. You can resume it in Manage billing.` };
    if ((sub.status === "active" || sub.status === "trialing") && sub.currentPeriodEnd) return { tone: "ok", text: `Pro (${INTERVAL_LABEL[sub.interval ?? ""] ?? "subscription"}) renews on ${dateLabel(sub.currentPeriodEnd)}.` };
    return null;
  })();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href={orgBase} className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" /> {context.organization.name}
        </Link>
        <h1 className="flex items-center gap-2 text-3xl font-extrabold">
          <CreditCard className="size-7 text-primary" aria-hidden="true" /> Billing
        </h1>
        <p className="text-sm text-muted-foreground">Plans are per organization. Only the organization owner can change billing.</p>
      </header>

      {returned === "applied" && (
        <p role="status" className="rounded-tbp-xl border border-primary/30 bg-primary/5 p-3 text-sm font-semibold text-primary">
          Thanks — your Pro subscription is active.
        </p>
      )}
      {returned === "pending" && (
        <p role="status" className="rounded-tbp-xl border border-border bg-secondary p-3 text-sm">
          We&apos;re confirming your payment with Stripe. This page updates once it&apos;s confirmed.
        </p>
      )}
      {sp.checkout === "cancel" && (
        <p role="status" className="rounded-tbp-xl border border-border bg-secondary p-3 text-sm">
          Checkout was canceled — nothing was charged.
        </p>
      )}
      {statusNote && (
        <p role={statusNote.tone === "warn" ? "alert" : "status"} className={`rounded-tbp-xl border p-3 text-sm ${statusNote.tone === "warn" ? "border-destructive/30 bg-destructive/5 text-destructive" : statusNote.tone === "ok" ? "border-primary/30 bg-primary/5" : "border-border bg-secondary"}`}>
          {statusNote.text}
        </p>
      )}

      <PlanUsageCard summary={summary} />

      <section aria-labelledby="billing-plan" className="space-y-4 rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <h2 id="billing-plan" className="text-lg font-extrabold">
          Pro for your organization
        </h2>
        {summary.plan === "LEGACY" && <p className="text-sm">Your organization has early access: everything it had before plans were introduced stays available. No subscription is needed.</p>}
        {summary.plan === "COMP" && <p className="text-sm">Your organization has complimentary Pro. No subscription is needed.</p>}
        {(summary.plan === "FREE" || summary.plan === "TRIAL" || summary.plan === "PRO") && !view.billingEnabled && <p className="text-sm text-muted-foreground">Pro plans and upgrades are coming soon. Your current plan keeps working as shown above.</p>}
        {summary.plan === "TRIAL" && view.billingEnabled && view.canPurchase && (
          <p className="text-sm">
            You&apos;re on the free Pro trial ({summary.trialDaysLeft} day{summary.trialDaysLeft === 1 ? "" : "s"} left). Nothing is charged when it ends — you move to Free. Subscribing now starts paid Pro immediately.
          </p>
        )}
        {view.billingEnabled && !view.isOwner && <p className="text-sm text-muted-foreground">Only the organization owner can start or change a subscription.</p>}
        {view.billingEnabled && view.isOwner && (view.canPurchase || view.canManage) && (
          <BillingActions organizationSlug={context.organization.slug} canPurchase={view.canPurchase} canManage={view.canManage} prices={view.prices} chargeNotice={CHECKOUT_CHARGE_NOTICE} />
        )}
      </section>

      <section aria-labelledby="billing-compare" className="space-y-3">
        <h2 id="billing-compare" className="text-lg font-extrabold">
          Free vs Pro
        </h2>
        <PlanComparison />
        <p className="text-xs text-muted-foreground">Prices in USD. Pro renews automatically until canceled; cancel any time in Manage billing (Pro stays until the end of the paid period). Reaching a limit never removes data.</p>
      </section>
    </div>
  );
}
