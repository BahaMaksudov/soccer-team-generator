import type { BillingConfig, BillingInterval } from "@/lib/billing/config";
import type { BillingStripe, StripePriceLite } from "@/lib/billing/stripe";

/**
 * M11.2B — the configured Price ids are verified against Stripe before a
 * Checkout is created. Both must be active, licensed, recurring Prices of the
 * configured mode (a test Price is never accepted by a live deployment and
 * vice versa), with the expected interval. In LIVE mode the amounts and the
 * Product are pinned too: USD 9.99 / month and USD 99 / year — the prices the
 * app shows — on one Product. Test-mode Prices (Preview) are not amount-pinned.
 * Any mismatch, or Stripe unreachable, fails closed: no Checkout. A successful
 * check is cached briefly per process.
 */
export const LIVE_PRICE_EXPECTATIONS: Record<BillingInterval, { currency: string; unit_amount: number }> = {
  month: { currency: "usd", unit_amount: 999 },
  year: { currency: "usd", unit_amount: 9900 },
};
const CACHE_MS = 10 * 60_000;
let cache: { key: string; at: number } | null = null;

export type PriceCheck = { ok: true } | { ok: false; problem: string };

export function checkPrice(price: StripePriceLite, interval: BillingInterval, livemode: boolean): string | null {
  if (price.livemode !== livemode) return `${interval} Price is not a ${livemode ? "live" : "test"}-mode Price`;
  if (!price.active) return `${interval} Price is inactive`;
  if (price.type !== "recurring" || !price.recurring) return `${interval} Price is not recurring`;
  if (price.recurring.interval !== interval || price.recurring.interval_count !== 1) return `${interval} Price bills every ${price.recurring.interval_count} ${price.recurring.interval}`;
  if (price.recurring.usage_type !== "licensed") return `${interval} Price is not licensed (per-unit) billing`;
  if (livemode) {
    const want = LIVE_PRICE_EXPECTATIONS[interval];
    if (price.currency !== want.currency || price.unit_amount !== want.unit_amount) return `${interval} Price amount is ${price.unit_amount ?? "?"} ${price.currency}, expected ${want.unit_amount} ${want.currency}`;
  }
  return null;
}

export async function verifyConfiguredPrices(config: Extract<BillingConfig, { enabled: true }>, stripe: BillingStripe, now = Date.now()): Promise<PriceCheck> {
  const key = `${config.livemode}:${config.prices.month}:${config.prices.year}`;
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return { ok: true };
  let month: StripePriceLite, year: StripePriceLite;
  try {
    [month, year] = await Promise.all([stripe.retrievePrice(config.prices.month), stripe.retrievePrice(config.prices.year)]);
  } catch (e) {
    return { ok: false, problem: `Price lookup failed (${(e as { type?: string })?.type ?? "error"})` };
  }
  const problem = checkPrice(month, "month", config.livemode) ?? checkPrice(year, "year", config.livemode) ?? (config.livemode && month.product !== year.product ? "the two Prices belong to different Products" : null);
  if (problem) return { ok: false, problem };
  cache = { key, at: now };
  return { ok: true };
}

/** Tests only. */
export function resetPriceCheckCacheForTests() {
  cache = null;
}
