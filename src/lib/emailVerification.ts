import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/emailAddress";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { sendVerificationEmail } from "@/lib/email";

/**
 * M5 — email ownership verification.
 *
 * - Token: 32 random bytes (base64url) in the emailed link; only its
 *   SHA-256 hash is stored, with the User id and the normalized email it
 *   was sent to. Valid for 24 hours, usable once.
 * - At most one live token per User: issuing a new token deletes the
 *   User's older unused ones (so an older link becomes "invalid").
 * - Every issue/consume for a User is serialized with a transaction-
 *   scoped advisory lock on that User, so concurrent resends/verifies
 *   resolve deterministically: exactly one verification succeeds, a
 *   replay gets VERIFICATION_USED.
 * - Consumption also requires the User's CURRENT normalized email to
 *   equal the token's email.
 * - Never consumed by GET: the /verify-email/[token] page only reads
 *   (getVerificationPreview); verifyEmailToken() runs from an explicit
 *   POST, so link scanners prefetching the URL cannot use it up.
 * - Verification is not an Organization grant: it never touches
 *   memberships or invitations.
 */

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const lockUser = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"email-verification:" + userId}))`;

/** Replaces the User's outstanding token with a new one, inside the caller's transaction. */
export async function issueVerificationTokenInTx(
  tx: Prisma.TransactionClient,
  user: { id: string; email: string },
  now: Date = new Date()
): Promise<{ token: string; expiresAt: Date }> {
  await lockUser(tx, user.id);
  await tx.emailVerificationToken.deleteMany({ where: { userId: user.id, usedAt: null } });
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
  await tx.emailVerificationToken.create({
    data: { userId: user.id, email: normalizeEmail(user.email), tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export type VerificationPreview =
  | { status: "valid"; email: string }
  | { status: "expired" }
  | { status: "used" }
  | { status: "invalid" };

/** Read-only state for the GET page. Never consumes anything. */
export async function getVerificationPreview(token: string, now: Date = new Date()): Promise<VerificationPreview> {
  if (!isWellFormedToken(token)) return { status: "invalid" };
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, usedAt: true },
  });
  if (!row) return { status: "invalid" };
  if (row.usedAt) return { status: "used" };
  if (row.expiresAt <= now) return { status: "expired" };
  return { status: "valid", email: row.email };
}

export type VerificationFailure = "VERIFICATION_INVALID" | "VERIFICATION_EXPIRED" | "VERIFICATION_USED";
export type VerifyEmailResult = { ok: true; userId: string; email: string } | { ok: false; code: VerificationFailure };

export async function verifyEmailToken(token: string, now: Date = new Date()): Promise<VerifyEmailResult> {
  if (!isWellFormedToken(token)) return { ok: false, code: "VERIFICATION_INVALID" };
  const tokenHash = hashToken(token);

  return prisma.$transaction(async (tx): Promise<VerifyEmailResult> => {
    const found = await tx.emailVerificationToken.findUnique({ where: { tokenHash }, select: { userId: true } });
    if (!found) return { ok: false, code: "VERIFICATION_INVALID" };
    await lockUser(tx, found.userId);

    // Re-read under the lock: a concurrent verify/resend may have changed it.
    const row = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, email: true, expiresAt: true, usedAt: true },
    });
    if (!row) return { ok: false, code: "VERIFICATION_INVALID" };
    if (row.usedAt) return { ok: false, code: "VERIFICATION_USED" };
    if (row.expiresAt <= now) return { ok: false, code: "VERIFICATION_EXPIRED" };

    const user = await tx.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    if (!user || normalizeEmail(user.email) !== row.email) return { ok: false, code: "VERIFICATION_INVALID" };

    const { count } = await tx.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return { ok: false, code: "VERIFICATION_USED" };

    await tx.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    await tx.emailVerificationToken.deleteMany({ where: { userId: row.userId, usedAt: null } });
    return { ok: true, userId: row.userId, email: row.email };
  });
}

/**
 * Sends the verification email. Delivery problems are reported as
 * `false` (logged without token/body) — the account stays intact and
 * the User can request a resend.
 */
export async function deliverVerificationEmail(params: {
  to: string;
  name: string | null;
  token: string;
  expiresAt: Date;
  next?: string | null;
}): Promise<boolean> {
  try {
    await sendVerificationEmail(params);
    return true;
  } catch (e) {
    console.error(`[email] verification email not sent: ${e instanceof Error ? e.name : "unknown error"}`);
    return false;
  }
}

export type ResendVerificationResult =
  | { ok: true; alreadyVerified: true }
  | { ok: true; alreadyVerified: false; emailSent: boolean };

/** Issues a replacement token for the given (session-resolved) User and emails it. */
export async function resendVerification(userId: string, next?: string | null): Promise<ResendVerificationResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, emailVerifiedAt: true },
  });
  if (!user) throw new Error("User not found");
  if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };

  const issued = await prisma.$transaction((tx) => issueVerificationTokenInTx(tx, user));
  const emailSent = await deliverVerificationEmail({ to: user.email, name: user.name, ...issued, next });
  return { ok: true, alreadyVerified: false, emailSent };
}
