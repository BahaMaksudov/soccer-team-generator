import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, emailSchema } from "@/lib/emailAddress";

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

// bcrypt only uses the first 72 BYTES of its input; longer passwords
// would be silently truncated, so they are rejected instead.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;
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

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash).catch(() => false);
}

// A real bcrypt hash of a random string (same cost), created once per
// process: comparing against it when the email is unknown keeps "no such
// user" and "wrong password" similar in timing, so response time does
// not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), BCRYPT_COST));

export type AuthenticatedUser = { id: string; email: string; name: string | null };

export type LegacyAdminEnv = Record<string, string | undefined>;

type UserLookup = {
  user: {
    findUnique(args: { where: { email: string } }): Promise<{ id: string; email: string; name: string | null; passwordHash: string } | null>;
  };
};

/**
 * Verifies email + password against the User table.
 *
 * TRANSITIONAL legacy fallback (M5): before M5 the only login was the
 * env credential ADMIN_EMAIL / ADMIN_PASSWORD_HASH. The existing owner's
 * User row was created (Phase 2C) with passwordHash copied from that
 * env hash, so the database path already authenticates them. If the
 * deployed env hash has since diverged from the stored copy, the
 * fallback still lets that ONE existing User sign in — but only:
 *   - when both env vars are set,
 *   - for the email equal to ADMIN_EMAIL,
 *   - when a User row with that email already exists (it never creates
 *     a User and never returns a synthetic identity),
 *   - and it grants nothing beyond that User's own memberships.
 * Each use is logged (no secrets) so it can be observed before the env
 * vars are removed; unsetting ADMIN_PASSWORD_HASH disables it.
 */
export async function authenticateCredentials(
  rawEmail: string | undefined,
  password: string | undefined,
  db: UserLookup = prisma,
  env: LegacyAdminEnv = process.env
): Promise<AuthenticatedUser | null> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!email || !password) return null;

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }

  const identity = { id: user.id, email: user.email, name: user.name };
  const matched = await matchUserPassword(user, password, env);
  if (matched === "legacy") {
    console.warn("[auth] Signed in via the transitional ADMIN_PASSWORD_HASH fallback (User.passwordHash did not match).");
  }
  return matched ? identity : null;
}

/**
 * The single place a password is checked for an EXISTING User row:
 * first against User.passwordHash (bcrypt); then — only if that fails —
 * the transitional ADMIN_PASSWORD_HASH fallback, under exactly the M5
 * conditions (both env vars set, and this User's normalized email equals
 * ADMIN_EMAIL). Used by login and by Change Password, so the fallback can
 * never be broader in one than the other. Returns which check matched,
 * or null. Never logs or returns either hash.
 */
export async function matchUserPassword(
  user: { email: string; passwordHash: string },
  password: string,
  env: LegacyAdminEnv = process.env
): Promise<"database" | "legacy" | null> {
  if (!password) return null;
  if (await verifyPassword(password, user.passwordHash)) return "database";

  const legacyEmail = normalizeEmail(env.ADMIN_EMAIL ?? "");
  const legacyHash = env.ADMIN_PASSWORD_HASH ?? "";
  if (legacyEmail && legacyHash && normalizeEmail(user.email) === legacyEmail && (await verifyPassword(password, legacyHash))) {
    return "legacy";
  }
  return null;
}
