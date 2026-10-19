import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { emailSchema } from "@/lib/emailAddress";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import type { AuthenticatedUser } from "@/lib/accounts";

/**
 * "Continue with Google" (NextAuth v4 Google provider, JWT sessions, no
 * adapter). Google proves IDENTITY ONLY: it never grants or reads a role —
 * Organization access stays exclusively in OrganizationMembership
 * (src/lib/tenantContext.ts), Player identity in Player.userId.
 *
 * M12-A — a Google account is identified by its stable account id (`sub`),
 * stored in OAuthAccount. It signs in ONLY as the User it is linked to; an
 * email match alone never links two accounts. Rules (emails are normalized):
 *   1. Google must assert `email_verified === true`; otherwise refused.
 *   2. Linked `sub` → that User (lastUsedAt updated). Nothing else changes.
 *   3. An explicit link intent (signed-in owner re-entered the password; a
 *      single-use 10-minute token in an httpOnly cookie) → the Google account is
 *      connected to THAT User, only when its verified email equals the User's
 *      email and the Google account isn't linked elsewhere. Then 2 applies.
 *   4. Not linked, and a User with this email exists:
 *        - password account → refused (GoogleLinkRequired): sign in with the
 *          password, then connect Google under Account → Sign-in methods;
 *        - unverified email → refused (AccountEmailUnverified);
 *        - Google-only account created before M12-A (no password, no Google
 *          link yet — it could only have been created by a Google sign-in for
 *          this email) → linked now (one-time backfill), then 2 applies.
 *   5. No User → one is created (emailVerifiedAt = now, Google display name,
 *      NO password) together with its link, in one transaction. It has no
 *      memberships and has not used the trial: the normal onboarding applies,
 *      and the one-trial-per-account rule (User.trialUsedAt) is unchanged.
 * Linking never touches trialUsedAt, memberships or the password.
 */

export const GOOGLE_PROVIDER_ID = "google";
export const LINK_INTENT_COOKIE = "tbp_link_google";
export const LINK_INTENT_TTL_MS = 10 * 60_000;

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

export type GoogleSignInFailure =
  | "GoogleEmailUnverified"
  | "AccountEmailUnverified"
  | "GoogleLinkRequired"
  | "GoogleEmailMismatch"
  | "GoogleAlreadyLinked"
  | "GoogleLinkExpired"
  | "GoogleAccountMissing";
export type GoogleSignInResult = { ok: true; user: AuthenticatedUser; created: boolean; linked: boolean } | { ok: false; code: GoogleSignInFailure };

const USER_SELECT = { id: true, email: true, name: true, emailVerifiedAt: true, passwordHash: true } as const;
type UserRow = { id: string; email: string; name: string | null; emailVerifiedAt: Date | null; passwordHash: string | null };

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Normalized email from a Google profile, or null when Google has not verified it. */
export function verifiedGoogleEmail(profile: unknown): string | null {
  const p = (profile ?? {}) as { email?: unknown; email_verified?: unknown };
  if (p.email_verified !== true || typeof p.email !== "string") return null;
  const parsed = emailSchema.safeParse(p.email);
  return parsed.success ? parsed.data : null;
}

/** Google's stable account id (`sub`), from the OAuth account or the profile. */
export function googleSubject(account: unknown, profile: unknown): string | null {
  const a = (account ?? {}) as { providerAccountId?: unknown };
  const p = (profile ?? {}) as { sub?: unknown };
  const sub = typeof a.providerAccountId === "string" && a.providerAccountId ? a.providerAccountId : typeof p.sub === "string" ? p.sub : null;
  return sub && sub.length <= 255 ? sub : null;
}

function displayName(profile: unknown): string | null {
  const name = (profile as { name?: unknown } | null)?.name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 100);
  return trimmed || null;
}

const ok = (row: UserRow, created: boolean, linked: boolean): GoogleSignInResult => ({ ok: true, user: { id: row.id, email: row.email, name: row.name }, created, linked });

/** Consume a link intent (single use) and connect the Google account to its User. */
async function linkWithIntent(token: string, sub: string, email: string, now: Date): Promise<GoogleSignInResult> {
  if (!isWellFormedToken(token)) return { ok: false, code: "GoogleLinkExpired" };
  return prisma.$transaction(async (tx): Promise<GoogleSignInResult> => {
    const intent = await tx.accountLinkIntent.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, userId: true, provider: true, expiresAt: true, usedAt: true } });
    if (!intent || intent.provider !== GOOGLE_PROVIDER_ID || intent.usedAt || intent.expiresAt <= now) return { ok: false, code: "GoogleLinkExpired" };
    const used = await tx.accountLinkIntent.updateMany({ where: { id: intent.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) return { ok: false, code: "GoogleLinkExpired" };
    const user = await tx.user.findUnique({ where: { id: intent.userId }, select: USER_SELECT });
    if (!user || !user.emailVerifiedAt) return { ok: false, code: "GoogleLinkExpired" };
    if (user.email !== email) return { ok: false, code: "GoogleEmailMismatch" };
    const taken = await tx.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: GOOGLE_PROVIDER_ID, providerAccountId: sub } }, select: { userId: true } });
    if (taken && taken.userId !== user.id) return { ok: false, code: "GoogleAlreadyLinked" };
    if (!taken) {
      const own = await tx.oAuthAccount.findUnique({ where: { userId_provider: { userId: user.id, provider: GOOGLE_PROVIDER_ID } }, select: { id: true } });
      if (own) return { ok: false, code: "GoogleAlreadyLinked" }; // a different Google account is already connected
      await tx.oAuthAccount.create({ data: { userId: user.id, provider: GOOGLE_PROVIDER_ID, providerAccountId: sub, emailAtLink: email, lastUsedAt: now } });
    }
    return ok(user, false, true);
  });
}

/** Called from the NextAuth signIn callback for the Google provider. */
export async function resolveGoogleSignIn(
  profile: unknown,
  account: unknown,
  options: { linkIntentToken?: string | null; now?: Date } = {}
): Promise<GoogleSignInResult> {
  const now = options.now ?? new Date();
  const email = verifiedGoogleEmail(profile);
  if (!email) return { ok: false, code: "GoogleEmailUnverified" };
  const sub = googleSubject(account, profile);
  if (!sub) return { ok: false, code: "GoogleAccountMissing" };

  if (options.linkIntentToken) return linkWithIntent(options.linkIntentToken, sub, email, now);

  for (let attempt = 0; attempt < 2; attempt++) {
    const link = await prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: GOOGLE_PROVIDER_ID, providerAccountId: sub } }, select: { id: true, user: { select: USER_SELECT } } });
    if (link) {
      if (!link.user.emailVerifiedAt) return { ok: false, code: "AccountEmailUnverified" };
      await prisma.oAuthAccount.update({ where: { id: link.id }, data: { lastUsedAt: now } });
      return ok(link.user, false, false);
    }
    const existing = await prisma.user.findUnique({ where: { email }, select: { ...USER_SELECT, oauthAccounts: { where: { provider: GOOGLE_PROVIDER_ID }, select: { id: true } } } });
    try {
      if (existing) {
        if (!existing.emailVerifiedAt) return { ok: false, code: "AccountEmailUnverified" };
        if (existing.passwordHash !== null) return { ok: false, code: "GoogleLinkRequired" };
        // A Google-only account already connected to ANOTHER Google account: never a second one by email.
        if (existing.oauthAccounts.length > 0) return { ok: false, code: "GoogleLinkRequired" };
        // Pre-M12-A Google-only account (created by a Google sign-in for this email): one-time backfill.
        await prisma.oAuthAccount.create({ data: { userId: existing.id, provider: GOOGLE_PROVIDER_ID, providerAccountId: sub, emailAtLink: email, lastUsedAt: now } });
        return ok(existing, false, true);
      }
      const created = await prisma.user.create({
        data: { email, name: displayName(profile), passwordHash: null, emailVerifiedAt: now, oauthAccounts: { create: { provider: GOOGLE_PROVIDER_ID, providerAccountId: sub, emailAtLink: email, lastUsedAt: now } } },
        select: USER_SELECT,
      });
      return ok(created, true, true);
    } catch (e) {
      // A concurrent sign-up / sign-in created the User or the link first: apply the rules to it once more.
      if (!isUniqueViolation(e) || attempt > 0) throw e;
    }
  }
  throw new Error("GoogleSignInUnresolved");
}

/**
 * The session identity for a Google sign-in that the signIn callback has
 * already allowed: the User LINKED to this Google account (never by email).
 */
export async function googleSessionUser(profile: unknown, account: unknown): Promise<AuthenticatedUser> {
  const sub = googleSubject(account, profile);
  const link = sub ? await prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: GOOGLE_PROVIDER_ID, providerAccountId: sub } }, select: { user: { select: USER_SELECT } } }) : null;
  if (!link || !link.user.emailVerifiedAt) throw new Error("GoogleSessionUserMissing");
  return { id: link.user.id, email: link.user.email, name: link.user.name };
}

// ------------------------------------------------------------------ explicit connect / disconnect

export type GoogleLinkStatus = { linked: boolean; emailAtLink: string | null; linkedAt: Date | null; lastUsedAt: Date | null };

export async function googleLinkStatus(userId: string): Promise<GoogleLinkStatus> {
  const row = await prisma.oAuthAccount.findUnique({ where: { userId_provider: { userId, provider: GOOGLE_PROVIDER_ID } }, select: { emailAtLink: true, createdAt: true, lastUsedAt: true } });
  return { linked: Boolean(row), emailAtLink: row?.emailAtLink ?? null, linkedAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

/** Creates the single-use intent (the caller verified the session AND the password). Returns the raw token for the cookie. */
export async function createGoogleLinkIntent(userId: string, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + LINK_INTENT_TTL_MS);
  await prisma.$transaction([
    // At most one live intent per User.
    prisma.accountLinkIntent.updateMany({ where: { userId, provider: GOOGLE_PROVIDER_ID, usedAt: null }, data: { usedAt: now } }),
    prisma.accountLinkIntent.create({ data: { userId, provider: GOOGLE_PROVIDER_ID, tokenHash: hashToken(token), expiresAt } }),
  ]);
  return { token, expiresAt };
}

/** Disconnect Google (the caller verified the session AND the password). True when a link was removed. */
export async function unlinkGoogle(userId: string): Promise<boolean> {
  const { count } = await prisma.oAuthAccount.deleteMany({ where: { userId, provider: GOOGLE_PROVIDER_ID } });
  return count > 0;
}
