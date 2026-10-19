import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/accounts";
import { sessionsCutoff } from "@/lib/passwordReset";

/**
 * M5.1 — authenticated Change Password.
 *
 * - The User is always the session-resolved User id passed in by the
 *   route; the body carries only the three password fields (anything
 *   else — userId, email, role, passwordHash… — is stripped by zod).
 * - The current password is verified with bcrypt against the User's own
 *   User.passwordHash — the only credential source.
 * - Only User.passwordHash is written (bcrypt, same cost as sign-up),
 *   guarded by the hash that was just verified so a concurrent change
 *   cannot be silently overwritten.
 * - UI-2 — an account that signs in with Google only (passwordHash NULL)
 *   has no password to change; setting a first password is not supported.
 * - M11.3 — a change also sets User.sessionsValidAfter (same rule as a password
 *   reset): every session issued up to now — other devices AND this one — stops
 *   working. The form already signs this browser out and asks to sign in again,
 *   so nothing changes for the person changing it; a stolen session elsewhere ends.
 */

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(1024),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.newPassword !== v.confirmPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmPassword"], message: "Passwords do not match." });
    }
    if (v.newPassword === v.currentPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["newPassword"], message: "Choose a password different from your current one." });
    }
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; code: "CURRENT_PASSWORD_INCORRECT" | "CONFLICT" | "NO_PASSWORD" | "RATE_LIMITED" };

/** M12-A — runs the current-password check under the database limit (src/lib/loginLimit.ts). Default: unlimited (tests / internal). */
export type PasswordGuard = (verify: () => Promise<boolean>) => Promise<"ok" | "invalid" | "limited">;
const unguarded: PasswordGuard = async (verify) => ((await verify()) ? "ok" : "invalid");

/** UI-2 — whether the account has a password (false for Google-only accounts). */
export async function accountHasPassword(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return !!user?.passwordHash;
}

export async function changePassword(userId: string, input: ChangePasswordInput, now: Date = new Date(), guard: PasswordGuard = unguarded): Promise<ChangePasswordResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
  if (!user) return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };
  if (!user.passwordHash) return { ok: false, code: "NO_PASSWORD" };

  const hash = user.passwordHash;
  const checked = await guard(() => verifyPassword(input.currentPassword, hash));
  if (checked === "limited") return { ok: false, code: "RATE_LIMITED" };
  if (checked !== "ok") return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };
  // newPassword !== currentPassword is enforced by changePasswordSchema.

  const passwordHash = await hashPassword(input.newPassword);
  const { count } = await prisma.user.updateMany({
    where: { id: userId, passwordHash: user.passwordHash },
    data: { passwordHash, sessionsValidAfter: sessionsCutoff(now) },
  });
  return count === 1 ? { ok: true } : { ok: false, code: "CONFLICT" };
}
