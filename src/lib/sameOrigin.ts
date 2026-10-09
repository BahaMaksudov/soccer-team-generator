/**
 * M9.3 — same-origin check for anonymous, capability-authorized mutations
 * (the Match Link answer endpoint). Browsers send Origin on every POST fetch;
 * the request must come from this deployment's own origin (the request URL's
 * origin, or APP_BASE_URL behind a proxy). A missing or foreign Origin is
 * refused. Complements the JSON-only content-type check (no simple-form CSRF).
 */
export function isSameOrigin(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  try {
    if (env.APP_BASE_URL) allowed.add(new URL(env.APP_BASE_URL).origin);
  } catch {
    /* ignore */
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host) allowed.add(`${proto}://${host}`);
  return allowed.has(origin);
}
