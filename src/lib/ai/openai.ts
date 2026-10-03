/**
 * M9-D — minimal server-side OpenAI client using the Responses API
 * (POST /v1/responses; no SDK, no framework, no Assistants). Configuration
 * only from the server environment:
 *
 *   OPENAI_API_KEY           required to enable AI (never NEXT_PUBLIC_*, never logged)
 *   OPENAI_MODEL             optional; defaults to DEFAULT_OPENAI_MODEL
 *   OPENAI_REASONING_EFFORT  optional; defaults to "low" (short constrained copywriting);
 *                            set to "off" to omit the reasoning parameter for models without it
 *   OPENAI_BASE_URL          optional (test injection); defaults to the official API
 *
 * The request carries no tools (no web/file search, code interpreter or MCP)
 * and `store: false`. Errors are classified for the caller and never carry
 * the key, the request or the provider's raw body to the browser.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_REASONING_EFFORT = "low";
export const AI_TIMEOUT_MS = 15_000;

export type AiErrorCode = "NOT_CONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_ERROR" | "EMPTY" | "INVALID" | "INCOMPLETE";

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

/** `maxTokens` bounds the whole response (reasoning + visible text) via max_output_tokens. */
export type ChatCompleter = (input: { system: string; user: string; maxTokens: number }) => Promise<string>;

type ResponsesBody = {
  status?: unknown;
  error?: unknown;
  output?: Array<{ type?: unknown; role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
};

/**
 * Visible text of a Responses API result: the `output_text` parts of the
 * assistant `message` items (reasoning items and refusals are ignored).
 * Throws AiError for anything but a completed response with text.
 */
export function extractResponseText(data: unknown): string {
  if (!data || typeof data !== "object") throw new AiError("INVALID");
  const body = data as ResponsesBody;
  if (body.error) throw new AiError("PROVIDER_ERROR");
  if (body.status === "incomplete") throw new AiError("INCOMPLETE");
  if (body.status !== "completed") throw new AiError(body.status === "failed" || body.status === "cancelled" ? "PROVIDER_ERROR" : "INVALID");
  if (!Array.isArray(body.output)) throw new AiError("INVALID");
  const parts: string[] = [];
  for (const item of body.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  const text = parts.join("");
  if (!text.trim()) throw new AiError("EMPTY");
  return text;
}

/** One Responses API call; throws AiError. */
export function openAiCompleter(env: Env = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = AI_TIMEOUT_MS): ChatCompleter {
  return async ({ system, user, maxTokens }) => {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) throw new AiError("NOT_CONFIGURED");
    const base = (env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    const model = env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
    const effort = env.OPENAI_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          instructions: system,
          input: user,
          max_output_tokens: maxTokens,
          ...(effort === "off" ? {} : { reasoning: { effort } }),
          text: { format: { type: "text" } },
          store: false,
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
    return extractResponseText(await res.json().catch(() => null));
  };
}
