import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emailSchema } from "@/lib/emailAddress";
import type { AuthenticatedUser } from "@/lib/accounts";

/**
 * UI-2 — "Continue with Google" (NextAuth v4 Google provider, JWT sessions,
 * no adapter). Google proves IDENTITY ONLY: it maps a Google account to the
 * one canonical Team Balance Pro User for that email. It never grants or
 * reads a role — Organization access stays exclusively in
 * OrganizationMembership (src/lib/tenantContext.ts), Player identity in
 * Player.userId.
 *
 * Rules (the email is always the normalized one, as everywhere else):
 *   - Google must assert `email_verified === true`; otherwise sign-in is refused.
 *   - An existing User whose email is VERIFIED signs in as that same User:
 *     same id, memberships, claimed Players, password (if any) — nothing is
 *     written and no second User is ever created.
 *   - An existing User whose email is NOT verified is refused: that row may
 *     have been registered by someone who never proved control of the
 *     address, and linking would hand them a verified account. The owner
 *     verifies via the existing email flow (or signs in with the password).
 *   - No User yet: one is created with the Google-verified email
 *     (emailVerifiedAt = now, so no redundant verification email), the
 *     Google display name, and NO password (passwordHash NULL). It has no
 *     memberships; the normal /admin → /onboarding flow applies.
 */

export const GOOGLE_PROVIDER_ID = "google";

type Env = Record<string, string | undefined>;

/** The provider is only registered when both credentials are configured. */
export function googleAuthConfig(env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isGoogleAuthConfigured(env: Env = process.env): boolean {
  return googleAuthConfig(env) !== null;
}

export type GoogleSignInFailure = "GoogleEmailUnverified" | "AccountEmailUnverified";
export type GoogleSignInResult = { ok: true; user: AuthenticatedUser; created: boolean } | { ok: false; code: GoogleSignInFailure };

type UserRow = { id: string; email: string; name: string | null; emailVerifiedAt: Date | null };
const USER_SELECT = { id: true, email: true, name: true, emailVerifiedAt: true } as const;

export type GoogleUserStore = {
  user: {
    findUnique(args: { where: { email: string }; select: typeof USER_SELECT }): Promise<UserRow | null>;
    create(args: {
      data: { email: string; name: string | null; passwordHash: null; emailVerifiedAt: Date };
      select: typeof USER_SELECT;
    }): Promise<UserRow>;
  };
};

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Normalized email from a Google profile, or null when Google has not verified it. */
export function verifiedGoogleEmail(profile: unknown): string | null {
  const p = (profile ?? {}) as { email?: unknown; email_verified?: unknown };
  if (p.email_verified !== true || typeof p.email !== "string") return null;
  const parsed = emailSchema.safeParse(p.email);
  return parsed.success ? parsed.data : null;
}

function displayName(profile: unknown): string | null {
  const name = (profile as { name?: unknown } | null)?.name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 100);
  return trimmed || null;
}

function decide(row: UserRow, created: boolean): GoogleSignInResult {
  if (!row.emailVerifiedAt) return { ok: false, code: "AccountEmailUnverified" };
  return { ok: true, user: { id: row.id, email: row.email, name: row.name }, created };
}

/** Called from the NextAuth signIn callback for the Google provider. */
export async function resolveGoogleSignIn(profile: unknown, db: GoogleUserStore = prisma, now: Date = new Date()): Promise<GoogleSignInResult> {
  const email = verifiedGoogleEmail(profile);
  if (!email) return { ok: false, code: "GoogleEmailUnverified" };

  const existing = await db.user.findUnique({ where: { email }, select: USER_SELECT });
  if (existing) return decide(existing, false);

  try {
    const created = await db.user.create({
      data: { email, name: displayName(profile), passwordHash: null, emailVerifiedAt: now },
      select: USER_SELECT,
    });
    return decide(created, true);
  } catch (e) {
    // A concurrent sign-up/sign-in created the row first: apply the same rules to it.
    if (!isUniqueViolation(e)) throw e;
    const raced = await db.user.findUnique({ where: { email }, select: USER_SELECT });
    if (!raced) throw e;
    return decide(raced, false);
  }
}

/**
 * The session identity for a Google sign-in that the signIn callback has
 * already allowed: the canonical User (by normalized, verified email).
 */
export async function googleSessionUser(profile: unknown, db: Pick<GoogleUserStore, "user"> = prisma): Promise<AuthenticatedUser> {
  const email = verifiedGoogleEmail(profile);
  const row = email ? await db.user.findUnique({ where: { email }, select: USER_SELECT }) : null;
  if (!row || !row.emailVerifiedAt) throw new Error("GoogleSessionUserMissing");
  return { id: row.id, email: row.email, name: row.name };
}
