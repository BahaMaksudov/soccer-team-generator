type Env = Record<string, string | undefined>;

/** True only for a database on this machine whose name says it is a test database. */
export function isLocalTestDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return /^postgres(ql)?:$/.test(u.protocol) && ["localhost", "127.0.0.1", "::1"].includes(host) && /test/i.test(decodeURIComponent(u.pathname.slice(1)));
  } catch {
    return false;
  }
}

/**
 * M13B P5 — the ONLY switch for RSVP delivery, decided on the server from the process
 * environment. There is no live mode: the result is the in-memory test outbox or nothing.
 *   "test-outbox" when NODE_ENV=test (automated tests), or in a CONFIRMED LOCAL TEST
 *                 environment: NODE_ENV=development AND RSVP_EMAIL_LOCAL_TEST_OUTBOX=1 AND
 *                 not on Vercel (no VERCEL / VERCEL_ENV) AND DATABASE_URL is a local
 *                 database whose name contains "test";
 *   "disabled"    everywhere else — every production build (Production and Preview run
 *                 NODE_ENV=production), whatever the email transport settings say.
 */
export function rsvpDeliveryMode(env: Env = process.env): "test-outbox" | "disabled" {
  if (env.NODE_ENV === "test") return "test-outbox";
  if (env.NODE_ENV === "development" && env.RSVP_EMAIL_LOCAL_TEST_OUTBOX === "1" && !env.VERCEL && !env.VERCEL_ENV && isLocalTestDatabaseUrl(env.DATABASE_URL)) return "test-outbox";
  return "disabled";
}
