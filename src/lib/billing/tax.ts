import type { BillingConfig } from "@/lib/billing/config";
import type { BillingStripe } from "@/lib/billing/stripe";

/**
 * M11.2C / M11.2G — Stripe Tax readiness, verified before every Checkout
 * (cached briefly). Every subscription Checkout uses automatic tax; it is
 * created only when
 *   - Stripe Tax is ACTIVE on the account (head office set) — Stripe needs this
 *     for automatic tax, so we fail early with a clear log line, and
 *   - the default tax behavior makes our USD prices tax-EXCLUSIVE (tax added
 *     on top), unless each Price sets "exclusive" itself (checked in prices.ts).
 * Any lookup failure fails closed (503, operator log line).
 * Tax collection LOCATIONS (registrations) are the owner's Stripe Tax
 * configuration, not an application requirement: Stripe adds tax only where a
 * location is configured and calculates $0 elsewhere; adding a location later
 * applies automatically (renewals keep automatic tax). The app never creates,
 * simulates or assumes a registration.
 */
const CACHE_MS = 10 * 60_000;
let cache: { key: string; at: number; defaultTaxBehavior: string | null } | null = null;

export type TaxCheck = { ok: true; defaultTaxBehavior: string | null } | { ok: false; problem: string };

export async function verifyTaxReadiness(config: Extract<BillingConfig, { enabled: true }>, stripe: BillingStripe, now = Date.now()): Promise<TaxCheck> {
  const key = `${config.livemode}`;
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return { ok: true, defaultTaxBehavior: cache.defaultTaxBehavior };
  try {
    const settings = await stripe.retrieveTaxSettings();
    if (settings.status !== "active") return { ok: false, problem: `Stripe Tax is not active (status ${settings.status})` };
    cache = { key, at: now, defaultTaxBehavior: settings.defaultTaxBehavior };
    return { ok: true, defaultTaxBehavior: settings.defaultTaxBehavior };
  } catch (e) {
    return { ok: false, problem: `Stripe Tax lookup failed (${(e as { type?: string })?.type ?? "error"})` };
  }
}

/** Tests only. */
export function resetTaxCheckCacheForTests() {
  cache = null;
}
