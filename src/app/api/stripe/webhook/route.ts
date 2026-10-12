import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/billing/webhook";

/**
 * M11.2A — Stripe webhook endpoint (TEST MODE). Not behind the login gate
 * (Stripe calls it); authenticity comes ONLY from the Stripe-Signature over
 * the RAW body (read as text, never parsed first). See src/lib/billing/webhook.ts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  const outcome = await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
  return NextResponse.json(outcome.body, { status: outcome.status, headers: { "Cache-Control": "no-store" } });
}
