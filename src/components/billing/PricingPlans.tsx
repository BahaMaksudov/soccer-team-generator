import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLAN_LIMITS, TRIAL_DAYS, type Limits } from "@/lib/entitlements";
import { BILLING_NOT_ACTIVE_NOTE, PRO_PRICES_USD } from "@/lib/billing/config";
import { LIVE_PRICE_EXPECTATIONS } from "@/lib/billing/prices";
import { cn } from "@/lib/cn";

/**
 * Public pricing cards (landing page + /pricing). Every limit comes from the
 * enforced plan catalog (PLAN_LIMITS) and every amount from the billing
 * configuration (PRO_PRICES_USD / the cent amounts the Stripe Price check
 * enforces), so the page can't promise something the app doesn't do.
 * Navigation only: Pro buttons go to /upgrade, which hands off to sign-in and
 * the existing Billing page (eligibility, duplicate protection, Checkout).
 */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Feature lines for a plan, in the order shown on the cards. */
export function planFeatures(l: Limits, opts: { upTo: boolean }): Array<{ text: string; included: boolean }> {
  const upTo = (n: number, one: string, many: string) => (opts.upTo ? `Up to ${plural(n, one, many)}` : plural(n, one, many));
  return [
    { text: l.activeGroups === null ? "Unlimited groups" : upTo(l.activeGroups, "group", "groups"), included: true },
    { text: l.activePlayers === null ? "Unlimited players" : `Up to ${plural(l.activePlayers, "player", "players")}`, included: true },
    { text: l.monthlyMatches === null ? "Unlimited matches" : `${plural(l.monthlyMatches, "match", "matches")} per month`, included: true },
    { text: l.activeSchedules === null ? "Unlimited recurring schedules" : plural(l.activeSchedules, "recurring schedule", "recurring schedules"), included: true },
    { text: l.monthlyAiRecaps === null ? "Unlimited AI recaps" : `${plural(l.monthlyAiRecaps, "AI recap", "AI recaps")} per month`, included: true },
    { text: "Unlimited balanced team generation", included: true },
    { text: l.telegram ? "Telegram integration included" : "Telegram integration not included", included: l.telegram },
  ];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** Yearly vs 12 × monthly, from the enforced Price amounts (cents). */
export const YEARLY_SAVINGS_CENTS = LIVE_PRICE_EXPECTATIONS.month.unit_amount * 12 - LIVE_PRICE_EXPECTATIONS.year.unit_amount;
export const YEARLY_SAVINGS_TEXT = `Save ${usd(YEARLY_SAVINGS_CENTS)} per year compared with monthly billing.`;
export const PRICING_FOOTNOTE =
  "Prices are in USD and billed in advance. Applicable taxes, if any, are shown during checkout. Subscriptions renew automatically until canceled; cancellation takes effect at the end of the current paid period.";

type Card = {
  id: "free" | "month" | "year";
  name: string;
  price: string;
  period: string;
  blurb?: string;
  highlight?: string;
  recommended?: boolean;
  features: Array<{ text: string; included: boolean }>;
  cta: { label: string; href: string };
};

function FeatureList({ items }: { items: Card["features"] }) {
  return (
    <ul className="space-y-2.5 text-sm">
      {items.map((f) => (
        <li key={f.text} className="flex items-start gap-2.5">
          {f.included ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className={f.included ? undefined : "text-muted-foreground"}>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `live`: paid billing is switched on (billingConfig().enabled, read by the page).
 * When it's off, Pro is shown as planned and its buttons are not offered.
 */
export default function PricingPlans({ live, headingLevel = "h2", id = "pricing" }: { live: boolean; headingLevel?: "h1" | "h2"; id?: string }) {
  const proFeatures = planFeatures(PLAN_LIMITS.PRO, { upTo: true });
  const cards: Card[] = [
    {
      id: "free",
      name: "Free",
      price: "$0",
      period: "forever",
      features: planFeatures(PLAN_LIMITS.FREE, { upTo: false }),
      cta: { label: "Get Started Free", href: "/signup" },
    },
    {
      id: "month",
      name: "Pro Monthly",
      price: PRO_PRICES_USD.month,
      period: "/month",
      recommended: true,
      features: proFeatures,
      cta: { label: "Get Pro Monthly", href: "/upgrade?plan=month" },
    },
    {
      id: "year",
      name: "Pro Yearly",
      price: PRO_PRICES_USD.year,
      period: "/year",
      blurb: "Includes all Pro features with annual billing.",
      highlight: YEARLY_SAVINGS_TEXT,
      features: proFeatures,
      cta: { label: "Get Pro Yearly", href: "/upgrade?plan=year" },
    },
  ];
  const Heading = headingLevel;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">Pricing</p>
        <Heading id={`${id}-title`} className="mt-2 font-display text-3xl font-extrabold sm:text-4xl">
          Simple pricing for every team
        </Heading>
        <p className="mt-3 text-muted-foreground">Start free. Upgrade when your team needs more.</p>
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {cards.map((c) => {
          const paid = c.id !== "free";
          return (
            <article
              key={c.id}
              aria-labelledby={`${id}-${c.id}-name`}
              className={cn(
                "relative flex flex-col rounded-tbp-2xl border bg-card p-6 shadow-card transition-shadow hover:shadow-lift",
                c.recommended ? "border-2 border-primary" : "border-border"
              )}
            >
              {c.recommended && (
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-0.5 text-xs font-bold text-primary-foreground">Recommended</span>
              )}
              <h3 id={`${id}-${c.id}-name`} className="font-display text-lg font-extrabold">
                {c.name}
              </h3>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-black tabular-nums">{c.price}</span>
                <span className="text-sm text-muted-foreground">{c.period}</span>
              </p>
              {paid && !live && <p className="mt-1 text-xs font-semibold text-muted-foreground">Planned price — not available yet</p>}
              {c.blurb && <p className="mt-3 text-sm text-muted-foreground">{c.blurb}</p>}
              {c.highlight && <p className="mt-3 rounded-tbp-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold">{c.highlight}</p>}
              <div className="mt-5 flex-1">
                <FeatureList items={c.features} />
              </div>
              <div className="mt-6">
                {paid && !live ? (
                  <Button type="button" size="lg" variant="outline" className="w-full" disabled>
                    Coming soon
                  </Button>
                ) : (
                  <Button asChild size="lg" variant={c.recommended ? "default" : "outline"} className="w-full">
                    <Link href={c.cta.href}>{c.cta.label}</Link>
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <p className="mx-auto mt-8 max-w-3xl text-center text-xs text-muted-foreground">
        {live ? PRICING_FOOTNOTE : BILLING_NOT_ACTIVE_NOTE} Your first organization includes a {TRIAL_DAYS}-day Pro trial, no card required. Both Pro plans include the same features; only the billing period and price differ.{" "}
        <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
          Terms of Service
        </Link>
      </p>
    </section>
  );
}
