import type { BillingConfig } from "@/lib/billing/config";
import type { BillingStripe } from "@/lib/billing/stripe";

/**
 * M11.2C — Stripe Tax readiness, verified before every Checkout (cached
 * briefly). Checkout always uses automatic tax; it is created only when
 *   - Stripe Tax is ACTIVE on the account (head office set), and
 *   - an ACTIVE US sales-tax registration exists for the business's home state
 *     (TAX_HOME_STATE — Massachusetts), and
 *   - the default tax behavior makes our USD prices tax-EXCLUSIVE (tax added
 *     on top), unless each Price sets "exclusive" itself (checked in prices.ts).
 * So Checkout never silently collects zero tax because Stripe Tax or the home
 * registration is missing: it fails closed instead (503, operator log line).
 * Registrations in other states are the owner's to add when nexus requires;
 * Stripe Tax then collects there automatically.
 */
export const TAX_HOME_STATE = "MA";
const CACHE_MS = 10 * 60_000;
let cache: { key: string; at: number; defaultTaxBehavior: string | null } | null = null;

export type TaxCheck = { ok: true; defaultTaxBehavior: string | null } | { ok: false; problem: string };

export async function verifyTaxReadiness(config: Extract<BillingConfig, { enabled: true }>, stripe: BillingStripe, now = Date.now()): Promise<TaxCheck> {
  const key = `${config.livemode}`;
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return { ok: true, defaultTaxBehavior: cache.defaultTaxBehavior };
  try {
    const settings = await stripe.retrieveTaxSettings();
    if (settings.status !== "active") return { ok: false, problem: `Stripe Tax is not active (status ${settings.status})` };
    const registrations = await stripe.listActiveTaxRegistrations();
    if (!registrations.some((r) => r.country === "US" && r.state === TAX_HOME_STATE)) return { ok: false, problem: `no active Stripe Tax registration for US-${TAX_HOME_STATE}` };
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
