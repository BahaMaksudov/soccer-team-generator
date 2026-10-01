/**
 * M5 — server-side email configuration (never NEXT_PUBLIC_*).
 *
 * APP_BASE_URL is the ONLY source of origin for links in emails. It is
 * never derived from a request's Host header (attacker-controlled), and
 * there is no fallback: a missing/invalid value fails closed.
 *   - production: must be an https origin (no path/query/credentials),
 *     not localhost;
 *   - development/test: an explicit http(s) origin.
 * EMAIL_FROM must be a single-line "Name <address>" or address.
 */
export class EmailConfigError extends Error {
  constructor(reason: string) {
    super(`Email configuration error: ${reason}`);
    this.name = "EmailConfigError";
  }
}

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function getAppBaseUrl(env: Env = process.env): string {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) throw new EmailConfigError("APP_BASE_URL is not set.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmailConfigError("APP_BASE_URL is not a valid URL.");
  }
  if (url.username || url.password) throw new EmailConfigError("APP_BASE_URL must not contain credentials.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new EmailConfigError("APP_BASE_URL must be an origin only (no path, query or fragment).");
  }
  if (env.NODE_ENV === "production") {
    if (url.protocol !== "https:") throw new EmailConfigError("APP_BASE_URL must use https in production.");
    if (LOCAL_HOSTS.has(url.hostname)) throw new EmailConfigError("APP_BASE_URL must not be localhost in production.");
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EmailConfigError("APP_BASE_URL must be http(s).");
  }
  return url.origin;
}

export function getEmailFrom(env: Env = process.env): string {
  const from = env.EMAIL_FROM?.trim();
  if (!from) throw new EmailConfigError("EMAIL_FROM is not set.");
  if (/[\r\n]/.test(from) || !/@/.test(from) || from.length > 200) {
    throw new EmailConfigError("EMAIL_FROM is malformed.");
  }
  return from;
}

/** Absolute application URL for an internal path, on APP_BASE_URL. */
export function appUrl(path: string, env: Env = process.env): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new EmailConfigError("Email links must use internal paths.");
  return `${getAppBaseUrl(env)}${path}`;
}
