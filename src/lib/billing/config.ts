/**
 * M11.2A / M11.2B — billing configuration and safety guards (server-only).
 *
 * Billing is OFF unless every condition holds:
 *   BILLING_ENABLED === "true"
 *   STRIPE_SECRET_KEY is either
 *     a TEST key (sk_test_ / rk_test_) — anywhere EXCEPT Vercel Production, or
 *     a LIVE key (sk_live_ / rk_live_, well-formed) — ONLY in Vercel Production
 *       (VERCEL_ENV=production) AND with BILLING_ALLOW_LIVE_MODE === "true";
 *   STRIPE_WEBHOOK_SECRET (whsec_), STRIPE_PRICE_PRO_MONTHLY and
 *     STRIPE_PRICE_PRO_ANNUAL (two distinct price_ ids) set.
 *   and, for LIVE only, no "billing-launch" owner item is pending in legal.ts
 *     (the billing, renewal, cancellation and refund terms are published).
 * Checkout additionally verifies both Prices against Stripe (prices.ts) and
 * fails closed if either is not an active recurring Price in the configured
 * mode. Secrets are never logged or returned.
 *
 * Mode isolation: a deployment uses exactly ONE Stripe mode. Live keys are
 * rejected in Preview and Development; test keys are rejected in Production;
 * webhook events, Checkout Sessions, Customers and subscriptions of the other
 * mode are never accepted (stripeModePermitted + the livemode checks in
 * webhook.ts, sync.ts and checkout.ts). Every billing path goes through
 * billingConfig().
 */
import { OWNER_ITEMS, type OwnerItem } from "@/lib/legal";

export const LIVE_MODE_SUPPORTED = true;

export type BillingInterval = "month" | "year";
/** Public copy while paid billing is not active (BILLING_ENABLED unset — Production today): prices are planned, nobody is charged. */
export const BILLING_NOT_ACTIVE_NOTE = "Paid Pro subscriptions aren't available yet, and nobody is charged. Pro prices shown are planned prices (USD, per organization). Reaching a Free limit never removes data.";
export const PRO_PRICES_USD: Record<BillingInterval, string> = { month: "$9.99", year: "$99" };

type Env = Record<string, string | undefined>;

export type BillingConfig =
  | {
      enabled: true;
      livemode: boolean;
      secretKey: string;
      webhookSecret: string;
      prices: Record<BillingInterval, string>;
      portalConfigurationId: string | null;
    }
  | { enabled: false; reason: "disabled" | "missing_configuration" | "live_key_rejected" | "test_key_in_production" | "billing_terms_pending" };

export function isLiveKey(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}
/** A plausibly real live key (Stripe keys are long alphanumeric strings); a truncated / placeholder value is refused. */
export function isWellFormedLiveKey(key: string): boolean {
  return /^(sk|rk)_live_[A-Za-z0-9]{24,}$/.test(key);
}
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

export function isVercelProduction(env: Env = process.env): boolean {
  return env.VERCEL_ENV?.trim() === "production";
}

/**
 * The ONE rule for which Stripe mode this deployment may use — for the
 * configured secret key AND for subscriptions already stored in the database.
 *   live: ONLY in the Vercel Production environment, and only when explicitly
 *         allowed (BILLING_ALLOW_LIVE_MODE=true) — never in Preview or Development;
 *   test: anywhere EXCEPT the Vercel Production environment.
 */
export function stripeModePermitted(livemode: boolean, env: Env = process.env): boolean {
  if (livemode) return LIVE_MODE_SUPPORTED && isVercelProduction(env) && env.BILLING_ALLOW_LIVE_MODE?.trim() === "true";
  return !isVercelProduction(env);
}

/** Live charges need the paid-subscription terms published first (legal.ts billing-launch items resolved). */
export function billingTermsPending(items: readonly OwnerItem[] = OWNER_ITEMS): boolean {
  return items.some((i) => i.category === "billing-launch");
}

export function billingConfig(env: Env = process.env, ownerItems: readonly OwnerItem[] = OWNER_ITEMS): BillingConfig {
  if (env.BILLING_ENABLED?.trim() !== "true") return { enabled: false, reason: "disabled" };
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (isLiveKey(secretKey)) {
    if (!stripeModePermitted(true, env)) return { enabled: false, reason: "live_key_rejected" };
    if (!isWellFormedLiveKey(secretKey)) return { enabled: false, reason: "missing_configuration" };
    if (billingTermsPending(ownerItems)) return { enabled: false, reason: "billing_terms_pending" };
  } else if (!isTestKey(secretKey)) {
    return { enabled: false, reason: "missing_configuration" };
  } else if (!stripeModePermitted(false, env)) {
    return { enabled: false, reason: "test_key_in_production" };
  }
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const month = env.STRIPE_PRICE_PRO_MONTHLY?.trim() ?? "";
  const year = env.STRIPE_PRICE_PRO_ANNUAL?.trim() ?? "";
  if (!webhookSecret.startsWith("whsec_") || !/^price_\w+$/.test(month) || !/^price_\w+$/.test(year) || month === year) {
    return { enabled: false, reason: "missing_configuration" };
  }
  return {
    enabled: true,
    livemode: isLiveKey(secretKey),
    secretKey,
    webhookSecret,
    prices: { month, year },
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || null,
  };
}

/** The server-side Price allow-list: interval → Price id (and back). Nothing else is ever accepted. */
export function priceFor(config: Extract<BillingConfig, { enabled: true }>, interval: unknown): string | null {
  return interval === "month" || interval === "year" ? config.prices[interval] : null;
}
export function intervalForPrice(config: Extract<BillingConfig, { enabled: true }>, priceId: string | null | undefined): BillingInterval | null {
  if (priceId === config.prices.month) return "month";
  if (priceId === config.prices.year) return "year";
  return null;
}

export const BILLING_UNAVAILABLE_MESSAGE = "Billing isn't available yet. Pro plans and upgrades are coming soon.";
