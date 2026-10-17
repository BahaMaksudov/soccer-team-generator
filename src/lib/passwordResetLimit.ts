import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rateLimitDigest } from "@/lib/rateLimitKeys";

/**
 * M11.3 — the password-reset rate limit that does NOT depend on Upstash.
 *
 * Upstash (src/lib/rateLimit.ts) is optional and fails OPEN (missing config or
 * an outage allows everything). Password reset sends email, so it must not rely
 * on it: every "Forgot password" request is checked against this request log in
 * the database the app already needs. If the database is unavailable the request
 * fails (fails CLOSED — no email can be triggered without the check).
 *
 * Limits (sliding windows):
 *   per client address  — 10 requests / 15 min        → 429 (account-independent)
 *   per email address   —  3 emails   / 30 min         → generic answer, nothing sent
 *   whole service       — 200 emails  / hour (circuit breaker against mass abuse of
 *                         the email provider) → generic answer, nothing sent, logged
 * Counted BEFORE any account lookup, identically for registered and unknown
 * addresses, so neither the answer nor its timing reveals whether an account exists.
 *
 * Privacy: only keyed HMAC-SHA256 digests of the normalized email and the client
 * address are stored (key: RATE_LIMIT_HASH_SECRET, else NEXTAUTH_SECRET — see
 * src/lib/rateLimitKeys.ts), never the values. Rows older than a
 * day are purged as new requests arrive.
 */
export const RESET_LIMITS = {
  ip: { max: 10, windowMs: 15 * 60_000 },
  email: { max: 3, windowMs: 30 * 60_000 },
  global: { max: 200, windowMs: 60 * 60_000 },
} as const;
const RETENTION_MS = 24 * 60 * 60_000;

export type ResetLimitDecision = "send" | "ip_limited" | "email_limited" | "global_limited";

const digest = (kind: string, value: string) => rateLimitDigest(kind, value);

const lock = (tx: Prisma.TransactionClient, key: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"pwreset-rl:" + key}))`;

/**
 * Decide and record one request (normalized email, client address). Concurrent
 * requests for the same email / address are serialized, so a burst can't slip
 * past a limit together.
 */
export async function checkPasswordResetLimit(email: string, clientAddress: string, now: Date = new Date()): Promise<ResetLimitDecision> {
  const emailHash = digest("email", email);
  const ipHash = digest("ip", clientAddress);
  return prisma.$transaction(async (tx): Promise<ResetLimitDecision> => {
    // Fixed order (ip, then email): no lock-order deadlock between two requests.
    await lock(tx, ipHash);
    await lock(tx, emailHash);
    const since = (ms: number) => new Date(now.getTime() - ms);
    const [byIp, byEmail, global] = await Promise.all([
      tx.passwordResetRequest.count({ where: { ipHash, createdAt: { gt: since(RESET_LIMITS.ip.windowMs) } } }),
      tx.passwordResetRequest.count({ where: { emailHash, allowed: true, createdAt: { gt: since(RESET_LIMITS.email.windowMs) } } }),
      tx.passwordResetRequest.count({ where: { allowed: true, createdAt: { gt: since(RESET_LIMITS.global.windowMs) } } }),
    ]);
    const decision: ResetLimitDecision =
      byIp >= RESET_LIMITS.ip.max ? "ip_limited" : byEmail >= RESET_LIMITS.email.max ? "email_limited" : global >= RESET_LIMITS.global.max ? "global_limited" : "send";
    await tx.passwordResetRequest.create({ data: { emailHash, ipHash, allowed: decision === "send", createdAt: now } });
    await tx.passwordResetRequest.deleteMany({ where: { createdAt: { lt: since(RETENTION_MS) } } });
    return decision;
  });
}
