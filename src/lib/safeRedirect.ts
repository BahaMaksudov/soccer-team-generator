/**
 * M5 — post-login redirect targets must be internal application paths.
 *
 * Accepts only a same-origin path ("/admin", "/invite/abc?x=1").
 * Rejects absolute URLs ("https://evil.example"), protocol-relative
 * ("//evil.example"), backslash tricks ("/\\evil.example"), scheme URLs
 * ("javascript:…") and anything with control characters — returning
 * `fallback` instead.
 */
export const DEFAULT_AFTER_LOGIN = "/admin";

const PROBE_ORIGIN = "http://internal.invalid";

export function safeCallbackPath(raw: unknown, fallback: string = DEFAULT_AFTER_LOGIN): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const url = new URL(raw, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * NextAuth `redirect` callback policy: same-origin only. Relative paths
 * are sanitized with safeCallbackPath(); absolute URLs are allowed only
 * when their origin equals the app's own `baseUrl`.
 */
export function safeAuthRedirect(url: string, baseUrl: string): string {
  if (url.startsWith("/")) return `${baseUrl}${safeCallbackPath(url)}`;
  try {
    const target = new URL(url);
    if (target.origin === new URL(baseUrl).origin) {
      return `${baseUrl}${safeCallbackPath(`${target.pathname}${target.search}${target.hash}`)}`;
    }
  } catch {
    // fall through
  }
  return `${baseUrl}${DEFAULT_AFTER_LOGIN}`;
}
