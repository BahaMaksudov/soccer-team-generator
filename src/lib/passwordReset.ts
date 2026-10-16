import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword, passwordSchema } from "@/lib/accounts";
import { normalizeEmail } from "@/lib/emailAddress";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { sendGoogleOnlyResetEmail, sendPasswordResetEmail } from "@/lib/email";

/**
 * M11.3 — Forgot password / Reset password.
 *
 * - Token: 32 random bytes (base64url) in the emailed link; only its SHA-256
 *   hash is stored. Valid 60 minutes, usable once. Issuing a new token deletes
 *   the User's older unused ones (an older link becomes "invalid").
 * - No enumeration: the route always answers the same generic message whether
 *   or not the email has an account, and preparePasswordReset() +
 *   deliverResetDispatch() run after the response (no timing difference).
 * - Credentials accounts get a reset link. A Google-only account (no password)
 *   gets a "sign in with Google" email instead — no token, no password is set.
 *   An unknown email gets nothing.
 * - Never consumed by GET: the /reset-password/[token] page only reads
 *   (getPasswordResetPreview); resetPassword() runs from an explicit POST, so
 *   link scanners prefetching the URL cannot use it up.
 * - Issue / consume for a User are serialized by a transaction-scoped advisory
 *   lock on that User: of concurrent resets with one token exactly one succeeds.
 * - After a reset: the new bcrypt hash, every outstanding reset token removed,
 *   and User.sessionsValidAfter = the next whole second, so every session issued
 *   before the reset stops working (authOptions jwt callback). The User signs in
 *   again with the new password.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const lockUser = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"password-reset:" + userId}))`;

export const forgotPasswordSchema = z.object({ email: z.string().trim().min(1).max(320) });

export const resetPasswordSchema = z
  .object({
    token: z.string().max(100),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.newPassword !== v.confirmPassword) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmPassword"], message: "Passwords do not match." });
  });

/** The generic answer to every forgot-password request (never reveals whether an account exists). */
export const FORGOT_PASSWORD_MESSAGE = "If an account exists for that email, we've sent instructions to reset the password. Check your inbox (and spam folder); the link is valid for 60 minutes.";

export type ResetDispatch =
  | { kind: "none" } // unknown email: nothing is sent
  | { kind: "google_only"; to: string; name: string | null }
  | { kind: "reset"; to: string; name: string | null; token: string; expiresAt: Date };

/** Decides and records (token) what a request should send. The caller delivers it (deliverResetDispatch). */
export async function preparePasswordReset(rawEmail: string, now: Date = new Date()): Promise<ResetDispatch> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "none" };
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, passwordHash: true } });
  if (!user) return { kind: "none" };
  if (!user.passwordHash) return { kind: "google_only", to: user.email, name: user.name };
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt } });
  });
  return { kind: "reset", to: user.email, name: user.name, token, expiresAt };
}

/** Sends what preparePasswordReset decided. Failures are logged (never the token or address) and swallowed. */
export async function deliverResetDispatch(d: ResetDispatch): Promise<void> {
  try {
    if (d.kind === "reset") await sendPasswordResetEmail({ to: d.to, name: d.name, token: d.token, expiresAt: d.expiresAt });
    else if (d.kind === "google_only") await sendGoogleOnlyResetEmail({ to: d.to, name: d.name });
  } catch (e) {
    console.error(`[email] password reset email not sent: ${e instanceof Error ? e.name : "unknown error"}`);
  }
}

export type ResetPreview = { status: "valid" | "expired" | "used" | "invalid" };

/** Read-only state for the GET page. Never consumes anything and reveals no account data. */
export async function getPasswordResetPreview(token: string, now: Date = new Date()): Promise<ResetPreview> {
  if (!isWellFormedToken(token)) return { status: "invalid" };
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) }, select: { expiresAt: true, usedAt: true } });
  if (!row) return { status: "invalid" };
  if (row.usedAt) return { status: "used" };
  if (row.expiresAt <= now) return { status: "expired" };
  return { status: "valid" };
}

export type ResetFailure = "RESET_INVALID" | "RESET_EXPIRED" | "RESET_USED";
export type ResetResult = { ok: true } | { ok: false; code: ResetFailure };

/**
 * A JWT's `iat` is in whole seconds: the cutoff is the NEXT whole second, so every
 * session issued up to and including the reset's own second is void (a sign-in in
 * that same second, practically impossible, would just need to sign in again).
 */
export const sessionsCutoff = (now: Date) => new Date((Math.floor(now.getTime() / 1000) + 1) * 1000);

export async function resetPassword(token: string, newPassword: string, now: Date = new Date()): Promise<ResetResult> {
  if (!isWellFormedToken(token)) return { ok: false, code: "RESET_INVALID" };
  const tokenHash = hashToken(token);
  // bcrypt outside the transaction (slow by design); the write below is guarded by the lock + conditional update.
  const found = await prisma.passwordResetToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!found) return { ok: false, code: "RESET_INVALID" };
  const passwordHash = await hashPassword(newPassword);

  return prisma.$transaction(async (tx): Promise<ResetResult> => {
    await lockUser(tx, found.userId);
    // Re-read under the lock: a concurrent reset / new request may have changed it.
    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, expiresAt: true, usedAt: true } });
    if (!row) return { ok: false, code: "RESET_INVALID" };
    if (row.usedAt) return { ok: false, code: "RESET_USED" };
    if (row.expiresAt <= now) return { ok: false, code: "RESET_EXPIRED" };
    const user = await tx.user.findUnique({ where: { id: row.userId }, select: { passwordHash: true } });
    // A Google-only account never gets a token; if the password was removed since, refuse rather than invent one.
    if (!user?.passwordHash) return { ok: false, code: "RESET_INVALID" };

    const { count } = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (count !== 1) return { ok: false, code: "RESET_USED" };
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, sessionsValidAfter: sessionsCutoff(now) } });
    await tx.passwordResetToken.deleteMany({ where: { userId: row.userId, usedAt: null } });
    return { ok: true };
  });
}

/**
 * Session check for the jwt callback: a token issued (iat, seconds) before the
 * User's last password reset — or for a User that no longer exists — is void.
 */
export function sessionIssuedBeforeReset(iat: unknown, sessionsValidAfter: Date | null): boolean {
  if (!sessionsValidAfter) return false;
  const issued = typeof iat === "number" ? iat : 0;
  return issued < Math.floor(sessionsValidAfter.getTime() / 1000);
}
