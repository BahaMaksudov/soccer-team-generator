import Link from "next/link";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import PlanComparison from "@/components/billing/PlanComparison";
import PricingPlans from "@/components/billing/PricingPlans";
import { TRIAL_DAYS } from "@/lib/entitlements";
import { cn } from "@/lib/cn";
import { BILLING_NOT_ACTIVE_NOTE, billingConfig, PRO_PRICES_USD } from "@/lib/billing/config";

/**
 * M11.2A — public pricing (indexable marketing page). Cards and comparison are
 * generated from the enforced plan catalog. No purchase happens here: Pro buttons
 * go through /upgrade to the organization's existing Billing page.
 */
export function generateMetadata() {
  const live = billingConfig().enabled;
  return {
    title: "Pricing — TeamBalance Pro",
    description: live
      ? `Free forever for one group, or Pro for ${PRO_PRICES_USD.month}/month (${PRO_PRICES_USD.year}/year) per organization. No card needed to start.`
      : `Free forever for one group, with a ${TRIAL_DAYS}-day Pro trial for your first organization. No card needed. Paid Pro plans are planned (${PRO_PRICES_USD.month}/month or ${PRO_PRICES_USD.year}/year per organization).`,
  };
}

export default function PricingPage() {
  // Read-only: whether paid billing is switched on (billing logic itself is unchanged).
  const live = billingConfig().enabled;
  return (
    <div
      className={cn(
        "min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased",
        "[&_h1]:font-display [&_h2]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]"
      )}
    >
      <MarketingHeader anchorBase="/" />
      <main id="main" className="mx-auto w-full max-w-6xl space-y-12 px-4 py-10 sm:px-6 sm:py-16">
        <PricingPlans live={live} headingLevel="h1" id="plans" />
        <section aria-labelledby="compare-title" className="mx-auto max-w-4xl space-y-4">
          <h2 id="compare-title" className="text-center text-2xl font-extrabold">
            Compare Free and Pro
          </h2>
          <PlanComparison planned={!live} />
          <p className="text-center text-xs text-muted-foreground">
            {live
              ? "Prices in USD, per organization, plus sales tax where we collect it (shown at checkout). Pro renews automatically until canceled and can be canceled any time; it stays active until the end of the paid period. Payments are non-refundable except as described in our Terms. Paid plans are available with a US billing address. Reaching a Free limit never removes data."
              : BILLING_NOT_ACTIVE_NOTE}
          </p>
          <p className="text-center text-xs text-muted-foreground">
            <Link href="/terms" className="underline-offset-2 hover:underline">
              Terms of Service
            </Link>
            {" · "}
            <Link href="/privacy" className="underline-offset-2 hover:underline">
              Privacy Policy
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
