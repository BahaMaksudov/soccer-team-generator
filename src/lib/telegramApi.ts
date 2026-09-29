/**
 * Phase 2D.6D.5D — minimal Telegram Bot API client shared by the
 * canonical Telegram mutations (create-poll, close-and-post). Moved
 * here from src/lib/telegramAdmin.ts; request shape and success
 * behavior are unchanged, and every thrown error is still an `Error`
 * carrying the same message, so existing `e.message` handling is
 * unaffected.
 *
 * The only addition is error CLASSIFICATION:
 *
 *   - TelegramApiRejectionError — Telegram returned a parsed JSON
 *     response with `ok: false`. This is a definite provider rejection:
 *     Telegram received the request and explicitly did not perform it.
 *
 *   - any other thrown error (network/transport failure, timeout,
 *     unparseable body, response without an `ok` field) — AMBIGUOUS:
 *     Telegram may or may not have performed the request. Callers must
 *     never treat these as "definitely not delivered".
 *
 * The legacy Publish path (src/lib/publishTeams.ts) keeps its own
 * private helper and is intentionally not migrated onto this module.
 */

export class TelegramApiRejectionError extends Error {
  readonly method: string;
  readonly errorCode: number | null;
  readonly description: string | null;

  constructor(method: string, description: string | null, errorCode: number | null) {
    super(description || "Telegram API error");
    this.name = "TelegramApiRejectionError";
    this.method = method;
    this.description = description;
    this.errorCode = errorCode;
  }
}

export async function callTelegram(method: string, body: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (data?.ok) {
    return data.result;
  }
  if (data && typeof data === "object" && data.ok === false) {
    throw new TelegramApiRejectionError(
      method,
      typeof data.description === "string" ? data.description : null,
      typeof data.error_code === "number" ? data.error_code : null
    );
  }
  // Unparseable / unexpected shape: we cannot tell what Telegram did.
  throw new Error(data?.description || "Telegram API error");
}
