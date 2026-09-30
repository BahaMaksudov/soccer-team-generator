/**
 * Phase 2D.6E.6C — fail-closed guard for real-database integration tests.
 *
 * Integration tests may ONLY run against an explicitly supplied,
 * disposable, LOCAL test database. This never falls back to
 * DATABASE_URL, and it refuses anything that looks like production:
 * the production Neon host, any Neon host, any non-local host, a
 * database name without "test", or the same database as DATABASE_URL
 * (from the environment or from the project's .env file).
 *
 * Error messages never include the URL (it may contain a password).
 */

export const FORBIDDEN_HOST_FRAGMENTS = ["ep-misty-butterfly", "neon.tech"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run integration tests: ${reason}`);
    this.name = "UnsafeTestDatabaseError";
  }
}

function identity(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase()}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return null;
  }
}

/**
 * Returns TEST_DATABASE_URL if — and only if — it is safe to use.
 * `otherDatabaseUrls` are URLs the test database must NOT equal
 * (e.g. DATABASE_URL from the environment and from .env).
 */
export function resolveSafeTestDatabaseUrl(
  env: Record<string, string | undefined>,
  otherDatabaseUrls: Array<string | undefined> = []
): string {
  if (env.NODE_ENV !== "test") throw new UnsafeTestDatabaseError("NODE_ENV must be 'test'.");

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not set (DATABASE_URL is never used as a fallback).");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must be a postgres:// or postgresql:// URL.");
  }

  const host = url.hostname.toLowerCase();
  if (FORBIDDEN_HOST_FRAGMENTS.some((f) => host.includes(f))) {
    throw new UnsafeTestDatabaseError(`host '${host}' is a known production/Neon host.`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(`host '${host}' is not local (localhost/127.0.0.1/::1 only).`);
  }

  const dbName = url.pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new UnsafeTestDatabaseError(`database name '${dbName}' must contain 'test'.`);
  }

  const self = identity(raw);
  for (const other of [env.DATABASE_URL, ...otherDatabaseUrls]) {
    if (!other) continue;
    if (other.trim() === raw || identity(other) === self) {
      throw new UnsafeTestDatabaseError("TEST_DATABASE_URL points at the same database as DATABASE_URL.");
    }
  }

  return raw;
}

/** Reads DATABASE_URL from a .env file's text without loading it into process.env. */
export function databaseUrlFromDotenv(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) return undefined;
  return line.replace(/^\s*DATABASE_URL\s*=\s*/, "").trim().replace(/^["']|["']$/g, "");
}
