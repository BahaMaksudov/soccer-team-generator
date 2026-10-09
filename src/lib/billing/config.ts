/**
 * M11.2A — billing configuration and safety guards (server-only).
 *
 * Billing is OFF unless every condition holds:
 *   BILLING_ENABLED === "true"
 *   STRIPE_SECRET_KEY is a TEST key (sk_test_ / rk_test_). Live keys are
 *     rejected throughout M11.2A — LIVE_MODE_SUPPORTED is false in code, so
 *     BILLING_ALLOW_LIVE_MODE cannot turn them on (M11.2B flips the constant).
 *   STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_ANNUAL set.
 * Production has none of these → billing disabled by default. Secrets are
 * never logged or returned.
 */
export const LIVE_MODE_SUPPORTED = false;

export type BillingInterval = "month" | "year";
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
  | { enabled: false; reason: "disabled" | "missing_configuration" | "live_key_rejected" };

export function isLiveKey(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

export function billingConfig(env: Env = process.env): BillingConfig {
  if (env.BILLING_ENABLED?.trim() !== "true") return { enabled: false, reason: "disabled" };
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (isLiveKey(secretKey)) {
    const allowed = LIVE_MODE_SUPPORTED && env.BILLING_ALLOW_LIVE_MODE?.trim() === "true";
    if (!allowed) return { enabled: false, reason: "live_key_rejected" };
  } else if (!isTestKey(secretKey)) {
    return { enabled: false, reason: "missing_configuration" };
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
