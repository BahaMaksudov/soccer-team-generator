import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, matchUserPassword, passwordSchema, verifyPassword, type LegacyAdminEnv } from "@/lib/accounts";

/**
 * M5.1 — authenticated Change Password.
 *
 * - The User is always the session-resolved User id passed in by the
 *   route; the body carries only the three password fields (anything
 *   else — userId, email, role, passwordHash… — is stripped by zod).
 * - The current password is checked with matchUserPassword(): the
 *   User's own bcrypt hash first, then — only for the one existing User
 *   whose email equals ADMIN_EMAIL, with both legacy env vars set — the
 *   transitional ADMIN_PASSWORD_HASH. That legacy path exists solely so
 *   the pre-M5 owner can move onto a database password; after the change
 *   their login matches User.passwordHash and never reaches the fallback.
 * - Only User.passwordHash is written (bcrypt, same cost as sign-up),
 *   guarded by the hash that was just verified so a concurrent change
 *   cannot be silently overwritten.
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
  | { ok: false; code: "CURRENT_PASSWORD_INCORRECT" | "NEW_PASSWORD_SAME" | "CONFLICT" };

export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  env: LegacyAdminEnv = process.env
): Promise<ChangePasswordResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
  if (!user) return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };

  const matched = await matchUserPassword(user, input.currentPassword, env);
  if (!matched) return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };
  if (matched === "legacy") {
    console.warn("[auth] Legacy password accepted for authenticated password transition");
  }
  // Also refuse re-using the password the database already holds
  // (relevant when the current password was accepted via the legacy hash).
  if (await verifyPassword(input.newPassword, user.passwordHash)) return { ok: false, code: "NEW_PASSWORD_SAME" };

  const passwordHash = await hashPassword(input.newPassword);
  const { count } = await prisma.user.updateMany({
    where: { id: userId, passwordHash: user.passwordHash },
    data: { passwordHash },
  });
  return count === 1 ? { ok: true } : { ok: false, code: "CONFLICT" };
}
