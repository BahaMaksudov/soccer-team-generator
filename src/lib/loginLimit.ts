import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/emailAddress";
import { rateLimitDigest } from "@/lib/rateLimitKeys";

/**
 * M12-A — database-backed limit for every password check (credentials sign-in,
 * change password, connect / disconnect Google). Upstash stays an optional first
 * layer; THIS is the authoritative one: it needs no external service and fails
 * CLOSED (no database → no password check → sign-in refused).
 *
 * Limits (rolling windows, failures only — a successful sign-in never uses up a
 * shared address's budget, so offices / schools / mobile carriers aren't
 * blocked by their own users signing in):
 *   per client address  — 10 failed checks / 15 min → refused for that address;
 *   per email           —  5 failed checks / 15 min since that email's last
 *                          successful sign-in → refused for that email …
 *   … EXCEPT from an address that signed in successfully as that email within the
 *     last 30 days ("known pair"): someone else hammering the email can't lock its
 *     owner out (the address limit still applies). Google sign-in and password
 *     reset are never limited by this either.
 * Lockouts are bounded: refused (BLOCKED) checks are not counted, so a lockout
 * ends 15 minutes after the failures that caused it.
 *
 * Concurrency: the check and the reservation run in one transaction under
 * advisory locks on the address and the email (fixed order). A reserved check is
 * PENDING and counts as a failure until settled, so a burst of parallel requests
 * can't all pass. A check whose settle never happens (crash) stays PENDING and
 * keeps counting as a failure until it leaves the window.
 *
 * Outward behavior: unknown and existing emails are counted identically, so a
 * limit response never reveals whether an account exists.
 *
 * Stored: keyed HMACs only (src/lib/rateLimitKeys.ts). Retention: SUCCESS rows 30
 * days (known pairs), everything else 1 day; purged as new checks arrive.
 */
export const LOGIN_LIMITS = {
  ipFailures: { max: 10, windowMs: 15 * 60_000 },
  emailFailures: { max: 5, windowMs: 15 * 60_000 },
  knownPairMs: 30 * 24 * 60 * 60_000,
  retentionMs: 24 * 60 * 60_000,
} as const;

export type PasswordCheckSource = "login" | "change-password" | "google-link";
// (LoginAttempt.source also records "password-reset" for recordEmailOwnershipProof.)
export type PasswordCheckOutcome = "ok" | "invalid" | "limited";

const lock = (tx: Prisma.TransactionClient, key: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"login-rl:" + key}))`;

type Reservation = { id: string } | "limited";

async function reserve(emailHash: string, ipHash: string, source: PasswordCheckSource, now: Date): Promise<Reservation> {
  const since = (ms: number) => new Date(now.getTime() - ms);
  return prisma.$transaction(async (tx): Promise<Reservation> => {
    await lock(tx, `ip:${ipHash}`);
    await lock(tx, `email:${emailHash}`);
    const lastSuccess = await tx.loginAttempt.findFirst({
      where: { emailHash, outcome: "SUCCESS", createdAt: { gt: since(LOGIN_LIMITS.emailFailures.windowMs) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const emailFrom = lastSuccess && lastSuccess.createdAt > since(LOGIN_LIMITS.emailFailures.windowMs) ? lastSuccess.createdAt : since(LOGIN_LIMITS.emailFailures.windowMs);
    const [ipFailures, emailFailures, knownPair] = await Promise.all([
      tx.loginAttempt.count({ where: { ipHash, outcome: { in: ["FAILURE", "PENDING"] }, createdAt: { gt: since(LOGIN_LIMITS.ipFailures.windowMs) } } }),
      tx.loginAttempt.count({ where: { emailHash, outcome: { in: ["FAILURE", "PENDING"] }, createdAt: { gt: emailFrom } } }),
      tx.loginAttempt.findFirst({ where: { emailHash, ipHash, outcome: "SUCCESS", createdAt: { gt: since(LOGIN_LIMITS.knownPairMs) } }, select: { id: true } }),
    ]);
    const limited = ipFailures >= LOGIN_LIMITS.ipFailures.max || (!knownPair && emailFailures >= LOGIN_LIMITS.emailFailures.max);
    const row = await tx.loginAttempt.create({ data: { emailHash, ipHash, source, outcome: limited ? "BLOCKED" : "PENDING", createdAt: now }, select: { id: true } });
    await tx.loginAttempt.deleteMany({
      where: { OR: [{ outcome: { not: "SUCCESS" }, createdAt: { lt: since(LOGIN_LIMITS.retentionMs) } }, { createdAt: { lt: since(LOGIN_LIMITS.knownPairMs) } }] },
    });
    return limited ? "limited" : { id: row.id };
  });
}

/**
 * Run ONE password check under the limit. `verify` performs the real check
 * (bcrypt; unknown emails cost a dummy compare). Throws if the database is
 * unavailable — callers must treat that as a refusal (fail closed).
 */
export async function checkPasswordWithLimit(
  params: { email: string; clientAddress: string; source: PasswordCheckSource; now?: Date },
  verify: () => Promise<boolean>
): Promise<PasswordCheckOutcome> {
  const now = params.now ?? new Date();
  const email = normalizeEmail(params.email);
  const reserved = await reserve(rateLimitDigest("login-email", email), rateLimitDigest("ip", params.clientAddress), params.source, now);
  if (reserved === "limited") return "limited";
  let ok = false;
  try {
    ok = await verify();
  } finally {
    // A failed settle leaves the row PENDING: it keeps counting as a failure (conservative).
    await prisma.loginAttempt.updateMany({ where: { id: reserved.id, outcome: "PENDING" }, data: { outcome: ok ? "SUCCESS" : "FAILURE", settledAt: new Date() } }).catch(() => {});
  }
  return ok ? "ok" : "invalid";
}

/**
 * A completed password reset proves control of the email's inbox: it counts as a
 * SUCCESS for that email (its failure count restarts), so the owner can sign in
 * with the new password right away. The client-address budget is untouched.
 * Best-effort: a failure here never undoes the reset.
 */
export async function recordEmailOwnershipProof(rawEmail: string, now: Date = new Date()): Promise<void> {
  await prisma.loginAttempt
    .create({ data: { emailHash: rateLimitDigest("login-email", normalizeEmail(rawEmail)), ipHash: rateLimitDigest("ip", "password-reset"), source: "password-reset", outcome: "SUCCESS", createdAt: now, settledAt: now } })
    .catch(() => {});
}

/** Error messages thrown from NextAuth's authorize (they become /login?error=<code> / signIn().error). */
export const LOGIN_RATE_LIMITED = "LoginRateLimited";
export const LOGIN_UNAVAILABLE = "LoginUnavailable";
