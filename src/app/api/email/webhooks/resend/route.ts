import { NextResponse } from "next/server";
import { verifyWebhook, webhookHeaders } from "@/lib/webhookSignature";
import { processResendEvent } from "@/lib/emailWebhook";

/**
 * M13B P6 — Resend webhook receiver (bounces / spam complaints → global RSVP-email
 * suppression). NOT yet registered with Resend: no endpoint URL or secret is configured
 * anywhere, so until RESEND_WEBHOOK_SECRET exists this answers 503 and processes
 * nothing (fail closed; the provider would retry later).
 * Order: size cap → signature (svix-id / svix-timestamp / svix-signature over the RAW
 * body, 5-minute replay window) → parse → idempotent processing by event id. Invalid or
 * stale signatures → 401 with no detail. Responses and logs carry no addresses.
 */
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: HEADERS });
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: HEADERS });

  const h = webhookHeaders(req.headers);
  const verified = verifyWebhook(raw, h, process.env.RESEND_WEBHOOK_SECRET);
  if (verified === "not_configured") return NextResponse.json({ error: "Webhook not configured" }, { status: 503, headers: HEADERS });
  if (verified !== "ok") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: HEADERS });

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: HEADERS });
  }
  if (!event || typeof event !== "object") return NextResponse.json({ error: "Bad request" }, { status: 400, headers: HEADERS });
  try {
    const r = await processResendEvent(h.id!, event as Parameters<typeof processResendEvent>[1]);
    return NextResponse.json({ ok: true, status: r.status, outcome: r.outcome }, { headers: HEADERS });
  } catch {
    console.error("[email-webhook] processing failed"); // no ids, no addresses
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS });
  }
}
