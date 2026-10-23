import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * M13B P6 — verification of Svix-signed webhooks (Resend's webhooks are delivered by
 * Svix; Resend documents the `svix-id`, `svix-timestamp` and `svix-signature` headers and
 * Svix verification). Implemented from Svix's published manual-verification spec
 * (docs.svix.com/receiving/verifying-payloads/how-manual), without adding a dependency:
 *   signed content = `${id}.${timestamp}.${rawBody}` (the body exactly as received)
 *   key            = base64-decode of the secret after its `whsec_` prefix
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   header         = space-delimited `v1,<signature>` entries (any one may match)
 * Signatures are compared in constant time; the timestamp must be within
 * WEBHOOK_TOLERANCE_SECONDS of now (replay window, the Svix libraries' default).
 * Unit-tested against the Svix documentation's published test vector.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookHeaders = { id: string | null; timestamp: string | null; signature: string | null };
export type VerifyResult = "ok" | "not_configured" | "missing_headers" | "stale" | "invalid";

/** Reads svix-* headers (Resend) or the equivalent webhook-* (Standard Webhooks) names. */
export function webhookHeaders(h: Headers): WebhookHeaders {
  return {
    id: h.get("svix-id") ?? h.get("webhook-id"),
    timestamp: h.get("svix-timestamp") ?? h.get("webhook-timestamp"),
    signature: h.get("svix-signature") ?? h.get("webhook-signature"),
  };
}

function secretKey(secret: string | undefined): Buffer | null {
  const s = secret?.trim();
  if (!s || !s.startsWith("whsec_")) return null;
  const key = Buffer.from(s.slice("whsec_".length), "base64");
  return key.length >= 16 ? key : null;
}

export function signWebhookForTests(secret: string, id: string, timestamp: string, body: string): string {
  const key = secretKey(secret);
  if (!key) throw new Error("bad test secret");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function verifyWebhook(rawBody: string, h: WebhookHeaders, secret: string | undefined, now: Date = new Date()): VerifyResult {
  const key = secretKey(secret);
  if (!key) return "not_configured";
  if (!h.id || !h.timestamp || !h.signature) return "missing_headers";
  if (!/^\d{1,12}$/.test(h.timestamp)) return "invalid";
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(h.timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return "stale";
  const expected = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest();
  for (const part of h.signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return "ok";
  }
  return "invalid";
}
