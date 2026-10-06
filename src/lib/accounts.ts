import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, emailSchema } from "@/lib/emailAddress";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@/lib/passwordRules";

/**
 * M5 — database-backed accounts (sign-up + credential verification).
 *
 * Authentication only answers "who is this User?". Authorization stays
 * exclusively in OrganizationMembership, resolved server-side on every
 * request by src/lib/tenantContext.ts — nothing here grants access to
 * any Organization (except accepting an explicit invitation, which is
 * bound to the invitation's own Organization/email/role).
 *
 * Never logs or returns a password, passwordHash or token.
 */

export { normalizeEmail, emailSchema };

// Shared with the sign-up form (client-safe module); see src/lib/passwordRules.ts.
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES };
const BCRYPT_COST = 12;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .refine((p) => Buffer.byteLength(p, "utf8") <= PASSWORD_MAX_BYTES, "Password is too long.");

const nameSchema = z.string().trim().min(1, "Name is required.").max(100, "Name is too long.");

/** Sign-up body. With `inviteToken` the email comes from the invitation, never from the client. */
export const signupSchema = z
  .object({
    name: nameSchema,
    email: z.string().optional(),
    password: passwordSchema,
    confirmPassword: z.string(),
    inviteToken: z.string().optional(),
    // M6-C — internal path to continue to after email verification (e.g. a
    // /claim#… link). Sanitized with safeCallbackPath before any use.
    next: z.string().max(2048).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.password !== v.confirmPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmPassword"], message: "Passwords do not match." });
    }
    if (!v.inviteToken) {
      const e = emailSchema.safeParse(v.email ?? "");
      if (!e.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Enter a valid email address." });
    }
  });

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  if (!passwordHash) return Promise.resolve(false); // UI-2 — Google-only account
  return bcrypt.compare(password, passwordHash).catch(() => false);
}

// A real bcrypt hash of a random string (same cost), created once per
// process: comparing against it when the email is unknown keeps "no such
// user" and "wrong password" similar in timing, so response time does
// not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), BCRYPT_COST));

export type AuthenticatedUser = { id: string; email: string; name: string | null };

type UserLookup = {
  user: {
    findUnique(args: { where: { email: string } }): Promise<{ id: string; email: string; name: string | null; passwordHash: string | null } | null>;
  };
};

/**
 * Verifies email + password against the User table: normalized email →
 * User row → bcrypt compare with User.passwordHash. That is the only
 * credential source (the pre-M5 ADMIN_EMAIL / ADMIN_PASSWORD_HASH
 * transition fallback was retired in M5.1 after the owner moved onto a
 * database password). Unknown emails still cost one bcrypt compare, so
 * timing does not reveal which accounts exist.
 *
 * UI-2 — a Google-only account has no passwordHash (NULL): no password can
 * ever match it, and it costs the same dummy compare as an unknown email.
 */
export async function authenticateCredentials(
  rawEmail: string | undefined,
  password: string | undefined,
  db: UserLookup = prisma
): Promise<AuthenticatedUser | null> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!email || !password) return null;

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, email: user.email, name: user.name };
}
