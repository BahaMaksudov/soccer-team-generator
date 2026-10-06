import { createHash, timingSafeEqual } from "node:crypto";

/**
 * M9.2 — authorization for scheduled automation endpoints.
 *
 * Vercel Cron calls the endpoint with `Authorization: Bearer <CRON_SECRET>`
 * when the CRON_SECRET environment variable is set on the project. Fail
 * closed: without a configured secret (or with a wrong/missing header) the
 * endpoint does nothing. Constant-time comparison of SHA-256 digests (equal
 * lengths, no early exit). The secret is never logged or returned.
 */
export type CronAuth = "ok" | "not_configured" | "unauthorized";

export function authorizeCron(req: Request, env: Record<string, string | undefined> = process.env): CronAuth {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return "not_configured";
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return presented.length > 0 && timingSafeEqual(a, b) ? "ok" : "unauthorized";
}
