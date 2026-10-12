import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { billingConfig } from "@/lib/billing/config";
import { billingStripe } from "@/lib/billing/stripe";
import { BillingException, syncSubscription } from "@/lib/billing/sync";

/**
 * M11.2A — Stripe webhook processing (POST /api/stripe/webhook).
 *
 *  1. Billing must be enabled (else 503; nothing is processed).
 *  2. The RAW body's Stripe-Signature is verified (SDK, 5-minute tolerance);
 *     forged / tampered / stale → 400. An event from the other Stripe mode → 400.
 *  3. The event id is recorded (RECEIVED). PROCESSED / IGNORED → 200, no work (duplicate).
 *  4. Relevant events re-fetch the subscription from Stripe and apply it
 *     (syncSubscription), which marks the event PROCESSED in the SAME commit.
 *  5. Transient failure (Stripe/database) → FAILED + 500 → Stripe retries.
 *     An inconsistent / unmatched event → EXCEPTION + 200 (visible to an
 *     operator; reconciliation retries it) — never silently discarded.
 * Nothing in the event payload is trusted except ids used to re-fetch.
 */
export type WebhookOutcome = { status: number; body: Record<string, unknown> };

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"]);
const INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_failed", "invoice.payment_action_required"]);

const idOf = (x: unknown): string | null => (typeof x === "string" ? x : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : null);

/** The subscription an event concerns (only an id — the state itself is always re-fetched). */
function subscriptionIdOf(event: Stripe.Event): string | null {
  const o = event.data.object as unknown as Record<string, unknown>;
  if (SUBSCRIPTION_EVENTS.has(event.type)) return idOf(o.id);
  if (event.type === "checkout.session.completed") return idOf(o.subscription);
  if (INVOICE_EVENTS.has(event.type)) {
    const parent = o.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    return idOf(parent?.subscription_details?.subscription) ?? idOf(o.subscription);
  }
  return null;
}

export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  const config = billingConfig();
  if (!config.enabled) return { status: 503, body: { error: "Billing is not enabled." } };
  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("missing signature");
    event = billingStripe().constructEvent(rawBody, signature, config.webhookSecret);
  } catch {
    return { status: 400, body: { error: "Invalid signature." } };
  }
  if (event.livemode !== config.livemode) return { status: 400, body: { error: "Wrong Stripe mode." } };

  const subscriptionId = subscriptionIdOf(event);
  const objectId = subscriptionId ?? idOf((event.data.object as unknown as Record<string, unknown>).id);
  const record = await prisma.stripeEvent.upsert({
    where: { id: event.id },
    update: { attempts: { increment: 1 } },
    create: { id: event.id, type: event.type, livemode: event.livemode, objectId, attempts: 1 },
  });
  if (record.status === "PROCESSED" || record.status === "IGNORED") return { status: 200, body: { received: true, duplicate: true } };

  try {
    if (event.type === "checkout.session.expired") {
      const sessionId = idOf((event.data.object as unknown as Record<string, unknown>).id);
      if (sessionId) await prisma.billingCheckoutSession.updateMany({ where: { stripeSessionId: sessionId, status: { in: ["CREATING", "OPEN"] } }, data: { status: "EXPIRED" } });
      await prisma.stripeEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
      return { status: 200, body: { received: true } };
    }
    if (event.type === "checkout.session.completed") {
      const sessionId = idOf((event.data.object as unknown as Record<string, unknown>).id);
      if (sessionId) await prisma.billingCheckoutSession.updateMany({ where: { stripeSessionId: sessionId, status: { in: ["CREATING", "OPEN"] } }, data: { status: "COMPLETED" } });
    }
    const handled = SUBSCRIPTION_EVENTS.has(event.type) || INVOICE_EVENTS.has(event.type) || event.type === "checkout.session.completed";
    if (!handled || !subscriptionId) {
      await prisma.stripeEvent.update({ where: { id: event.id }, data: { status: "IGNORED", processedAt: new Date() } });
      return { status: 200, body: { received: true, ignored: true } };
    }
    await syncSubscription(subscriptionId, { actor: `stripe:${event.id}`, eventId: event.id });
    return { status: 200, body: { received: true } };
  } catch (e) {
    const message = (e instanceof Error ? e.message : "error").slice(0, 300);
    if (e instanceof BillingException) {
      await prisma.stripeEvent.update({ where: { id: event.id }, data: { status: "EXCEPTION", error: message } });
      console.error(`[billing] webhook ${event.id} (${event.type}) needs an operator: ${message}`);
      return { status: 200, body: { received: true, exception: true } };
    }
    await prisma.stripeEvent.update({ where: { id: event.id }, data: { status: "FAILED", error: message } }).catch(() => {});
    console.error(`[billing] webhook ${event.id} (${event.type}) failed; Stripe will retry: ${message}`);
    return { status: 500, body: { error: "Temporary failure." } };
  }
}
