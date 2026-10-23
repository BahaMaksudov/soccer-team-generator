import { EmailConfigError } from "./config";

/**
 * M5 — email transports behind one small interface, so provider code
 * never appears in routes/services.
 *
 *   - Resend (production): POST https://api.resend.com/emails with the
 *     server-only RESEND_API_KEY, via fetch (no SDK).
 *   - In-memory outbox: the ONLY transport available when
 *     NODE_ENV === "test" — automated tests can never send real email.
 *   - Console (local development without RESEND_API_KEY only): prints
 *     the message so links can be followed locally. Never in production.
 *
 * Diagnostics never include the API key, message bodies, links or tokens
 * — only provider, HTTP status and the provider's message id.
 */

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** M11.3 — sent as Resend's Idempotency-Key header: a retry with the same key is never delivered twice (provider window: 24 h). */
  idempotencyKey?: string;
  /**
   * M13B P3 — extra MESSAGE headers (RFC 8058 one-click unsubscribe for RSVP emails).
   * Only the allow-listed names below; values must be single-line (checked before sending).
   */
  headers?: Record<string, string>;
};

/** M13B P3 — the only extra email headers the app may set. */
export const ALLOWED_MESSAGE_HEADERS = ["List-Unsubscribe", "List-Unsubscribe-Post"] as const;

/** Throws (before any network call) on a non-allow-listed name or a value with CR/LF or other control characters. */
export function assertSafeMessageHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    if (!(ALLOWED_MESSAGE_HEADERS as readonly string[]).includes(name)) throw new Error(`Email header not allowed: ${name}`);
    // eslint-disable-next-line no-control-regex
    if (typeof value !== "string" || value.length === 0 || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Email header value invalid: ${name}`);
  }
}
export type SendResult = { providerMessageId: string | null };

export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail & { from: string }): Promise<SendResult>;
}

/** Thrown when a provider definitively did not accept the message. Safe to log; never shown raw to users. */
export class EmailDeliveryError extends Error {
  readonly reason: "http" | "network" | "timeout";
  readonly status: number | null;
  /** M13B P8A.1 — the provider's Retry-After (seconds, capped), when it sent one. */
  readonly retryAfterSeconds: number | null;
  constructor(reason: "http" | "network" | "timeout", status: number | null = null, retryAfterSeconds: number | null = null) {
    super(`Email delivery failed (${reason}${status ? ` ${status}` : ""}).`);
    this.name = "EmailDeliveryError";
    this.reason = reason;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Retry-After / ratelimit-reset as whole seconds (Resend documents seconds), capped at one hour; null if absent or unparseable. */
export function parseRetryAfter(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after") ?? headers?.get("ratelimit-reset");
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()), 3600);
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

export function createResendTransport(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EmailTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  return {
    name: "resend",
    async send(message) {
      assertSafeMessageHeaders(message.headers);
      let res: Response;
      try {
        res = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.headers ? { headers: message.headers } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        console.error(`[email] provider=resend delivery failed: ${timeout ? "timeout" : "network error"}`);
        throw new EmailDeliveryError(timeout ? "timeout" : "network");
      }

      if (!res.ok) {
        console.error(`[email] provider=resend delivery failed: HTTP ${res.status}`);
        throw new EmailDeliveryError("http", res.status, parseRetryAfter(res.headers));
      }

      // 2xx means Resend accepted the message. A malformed body does not
      // undo that, so it is logged and treated as sent (id unknown).
      const body: unknown = await res.json().catch(() => null);
      const id = body && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : null;
      if (!id) console.warn(`[email] provider=resend accepted (HTTP ${res.status}) but returned no message id`);
      else console.info(`[email] provider=resend accepted id=${id}`);
      return { providerMessageId: id };
    },
  };
}

/** M13B P8A — whether a Resend API key is configured (the key itself never leaves this module). */
export function resendKeyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

/**
 * M13B P8A — a SEPARATE Resend transport instance for RSVP invitations (live pilot only;
 * the caller gates it). Account / security email keeps using getEmailTransport().
 */
export function createRsvpResendTransport(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): EmailTransport {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new EmailConfigError("RESEND_API_KEY is not set.");
  return createResendTransport({ apiKey, fetchImpl });
}

export type CapturedEmail = OutgoingEmail & { from: string };

/** In-memory transport: records messages; never touches the network. */
export function createMemoryTransport(): EmailTransport & { sent: CapturedEmail[]; failNext: number; clear(): void } {
  const t = {
    name: "memory",
    sent: [] as CapturedEmail[],
    failNext: 0,
    clear() {
      t.sent.length = 0;
      t.failNext = 0;
    },
    async send(message: CapturedEmail): Promise<SendResult> {
      assertSafeMessageHeaders(message.headers); // same contract as the real provider path
      if (t.failNext > 0) {
        t.failNext--;
        throw new EmailDeliveryError("http", 503);
      }
      t.sent.push({ ...message });
      return { providerMessageId: `memory-${t.sent.length}` };
    },
  };
  return t;
}

/** Shared outbox used automatically under NODE_ENV=test. */
export const testOutbox = createMemoryTransport();

const consoleTransport: EmailTransport = {
  name: "console",
  async send(message) {
    console.info(`[email:dev] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
    return { providerMessageId: null };
  },
};

let override: EmailTransport | null = null;

/** Test hook: route all email through `transport` (null restores the default). */
export function setEmailTransportForTests(transport: EmailTransport | null): void {
  override = transport;
}

export function getEmailTransport(env: Record<string, string | undefined> = process.env): EmailTransport {
  if (override) return override;
  if (env.NODE_ENV === "test") return testOutbox;
  const apiKey = env.RESEND_API_KEY?.trim();
  if (apiKey) return createResendTransport({ apiKey });
  if (env.NODE_ENV !== "production") return consoleTransport;
  throw new EmailConfigError("RESEND_API_KEY is not set.");
}
