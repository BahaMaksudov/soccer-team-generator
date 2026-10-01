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

export type OutgoingEmail = { to: string; subject: string; text: string; html: string };
export type SendResult = { providerMessageId: string | null };

export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail & { from: string }): Promise<SendResult>;
}

/** Thrown when a provider definitively did not accept the message. Safe to log; never shown raw to users. */
export class EmailDeliveryError extends Error {
  readonly reason: "http" | "network" | "timeout";
  readonly status: number | null;
  constructor(reason: "http" | "network" | "timeout", status: number | null = null) {
    super(`Email delivery failed (${reason}${status ? ` ${status}` : ""}).`);
    this.name = "EmailDeliveryError";
    this.reason = reason;
    this.status = status;
  }
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
      let res: Response;
      try {
        res = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
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
        throw new EmailDeliveryError("http", res.status);
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
