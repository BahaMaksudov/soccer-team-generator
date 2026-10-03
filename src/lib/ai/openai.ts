/**
 * M9-D — minimal server-side OpenAI Chat Completions client (no SDK, no
 * framework). Configuration only from the server environment:
 *
 *   OPENAI_API_KEY   required to enable AI (never NEXT_PUBLIC_*, never logged)
 *   OPENAI_MODEL     optional; defaults to DEFAULT_OPENAI_MODEL
 *   OPENAI_BASE_URL  optional; defaults to https://api.openai.com/v1
 *
 * Errors are classified for the caller and never carry the key, the request
 * or the provider's raw body to the browser.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const AI_TIMEOUT_MS = 15_000;

export type AiErrorCode = "NOT_CONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_ERROR" | "EMPTY" | "INVALID";

export class AiError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode) {
    super(code);
    this.name = "AiError";
    this.code = code;
  }
}

type Env = Record<string, string | undefined>;

export function aiConfigured(env: Env = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export type ChatCompleter = (input: { system: string; user: string; maxTokens: number }) => Promise<string>;

/** One chat completion; throws AiError. */
export function openAiCompleter(env: Env = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = AI_TIMEOUT_MS): ChatCompleter {
  return async ({ system, user, maxTokens }) => {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) throw new AiError("NOT_CONFIGURED");
    const base = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new AiError(controller.signal.aborted || (e as Error)?.name === "AbortError" ? "TIMEOUT" : "PROVIDER_ERROR");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new AiError("RATE_LIMITED");
    if (!res.ok) throw new AiError("PROVIDER_ERROR");
    const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AiError("INVALID");
    return text;
  };
}
