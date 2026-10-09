import Link from "next/link";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import PlanComparison from "@/components/billing/PlanComparison";
import { Button } from "@/components/ui/button";
import { TRIAL_DAYS } from "@/lib/entitlements";
import { cn } from "@/lib/cn";

/**
 * M11.2A — public pricing (indexable marketing page). The comparison is
 * generated from the enforced plan catalog. No purchase happens here: owners
 * subscribe from their organization's Billing page.
 */
export const metadata = {
  title: "Pricing — Team Balance Pro",
  description: "Free forever for one group, or Pro for $9.99/month ($99/year) per organization. No card needed to start.",
};

export default function PricingPage() {
  return (
    <div
      className={cn(
        "min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased",
        "[&_h1]:font-display [&_h2]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]"
      )}
    >
      <MarketingHeader anchorBase="/" />
      <main id="main" className="mx-auto w-full max-w-4xl space-y-8 px-4 py-10 sm:py-16">
        <header className="space-y-3 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">Pricing</p>
          <h1 className="text-4xl font-black leading-tight sm:text-5xl">Simple plans for pickup sports</h1>
          <p className="mx-auto max-w-2xl text-muted-foreground">
            Start free — your first organization includes a {TRIAL_DAYS}-day Pro trial with no card required. Nothing is charged when it ends; you simply move to Free.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Get started free</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </header>
        <PlanComparison />
        <p className="text-center text-xs text-muted-foreground">Prices in USD, per organization. Pro renews automatically until canceled and can be canceled any time; it stays active until the end of the paid period. Reaching a Free limit never removes data.</p>
      </main>
    </div>
  );
}
