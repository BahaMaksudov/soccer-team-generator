import { createHash } from "node:crypto";
import type { BillingAddress } from "@/lib/billing/stripe";

/**
 * M11.2C — US-only paid subscriptions, enforced on the SERVER before Stripe is
 * called. Stripe Checkout cannot restrict billing countries (allowed_countries
 * exists only for shipping), so the owner enters the billing address in our
 * form; it must be a US address (50 states + DC). The server stores it on the
 * Stripe Customer — where Stripe Tax validates it — and Checkout is created
 * with customer_update.address = "never", so it cannot be changed to another
 * country there. Nothing about the address is stored in our database except a
 * one-way fingerprint on the Checkout operation (to never reuse a session that
 * was created for a different address).
 */
import { US_ONLY_MESSAGE, US_STATES } from "@/lib/billing/usStates";
export { US_ONLY_MESSAGE, US_STATES };

export type AddressResult = { ok: true; address: BillingAddress } | { ok: false; error: string; field?: "line1" | "line2" | "city" | "state" | "postal_code" | "country" };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max + 1) : "");

export function parseUsBillingAddress(input: unknown): AddressResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Enter your billing address." };
  const a = input as Record<string, unknown>;
  const country = text(a.country ?? "US", 2).toUpperCase();
  if (country !== "US") return { ok: false, error: US_ONLY_MESSAGE, field: "country" };
  const line1 = text(a.line1, 100);
  const line2 = text(a.line2, 100);
  const city = text(a.city, 60);
  const state = text(a.state, 2).toUpperCase();
  const postal = text(a.postal_code, 10);
  if (!line1 || line1.length > 100) return { ok: false, error: "Enter the street address.", field: "line1" };
  if (line2.length > 100) return { ok: false, error: "The second address line is too long.", field: "line2" };
  if (!city || city.length > 60) return { ok: false, error: "Enter the city.", field: "city" };
  if (!(US_STATES as readonly string[]).includes(state)) return { ok: false, error: `Choose a US state. ${US_ONLY_MESSAGE}`, field: "state" };
  if (!/^\d{5}(-\d{4})?$/.test(postal)) return { ok: false, error: "Enter a 5-digit US ZIP code.", field: "postal_code" };
  return { ok: true, address: { line1, line2: line2 || null, city, state, postal_code: postal, country: "US" } };
}

/** One-way fingerprint of interval + address + terms version (no address is stored). */
export function checkoutRequestHash(interval: string, address: BillingAddress, termsVersion: string): string {
  return createHash("sha256").update(JSON.stringify([interval, address.line1, address.line2, address.city, address.state, address.postal_code, address.country, termsVersion])).digest("hex");
}
