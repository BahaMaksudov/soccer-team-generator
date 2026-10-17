import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { authenticateCredentials, normalizeEmail } from "@/lib/accounts";
import { safeAuthRedirect } from "@/lib/safeRedirect";
import { cookies } from "next/headers";
import { GOOGLE_PROVIDER_ID, googleAuthConfig, googleSessionUser, LINK_INTENT_COOKIE, resolveGoogleSignIn } from "@/lib/googleAuth";
import { prisma } from "@/lib/prisma";
import { sessionIssuedBeforeReset } from "@/lib/passwordReset";

const google = googleAuthConfig();

/**
 * M5 — database-backed Credentials login (src/lib/accounts.ts). The
 * session/JWT carries identity only (User.id + email + name) — never a
 * password hash and never a role: Organization access and roles are
 * re-read from OrganizationMembership on every request
 * (src/lib/tenantContext.ts), so role changes or removed memberships
 * take effect immediately instead of living on in a long-lived token.
 *
 * UI-2 — optional Google sign-in, registered only when GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set. It resolves to the same canonical User
 * (src/lib/googleAuth.ts) and the same identity-only token.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = normalizeEmail(credentials?.email ?? "");
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        // Rate-limited by the submitted email so a scripted brute force
        // against one account can't run unbounded. See
        // src/lib/rateLimit.ts for activation requirements.
        const { allowed } = await checkLoginRateLimit(email);
        if (!allowed) return null;

        return authenticateCredentials(email, password);
      },
    }),
    ...(google ? [GoogleProvider({ clientId: google.clientId, clientSecret: google.clientSecret })] : []),
  ],
  session: { strategy: "jwt" },
  // OAuth errors (and refused Google sign-ins) land on /login?error=<code>.
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== GOOGLE_PROVIDER_ID) return true;
      // M12-A — an explicit "Connect Google" started on Account → Sign-in methods leaves a
      // single-use intent cookie (httpOnly, /api/auth, 10 min). Read it once and clear it.
      const linkIntentToken = await takeLinkIntentCookie();
      const result = await resolveGoogleSignIn(profile, account, { linkIntentToken });
      if (result.ok) return true;
      // A failed CONNECT returns to the account page (still signed in as before); a failed sign-in to /login.
      return linkIntentToken ? `/account/security?googleError=${result.code}` : `/login?error=${result.code}`;
    },
    async jwt({ token, user, account, profile }) {
      if (user && account?.provider === GOOGLE_PROVIDER_ID) {
        // Never the Google subject id or picture: the canonical User only.
        const dbUser = await googleSessionUser(profile, account);
        return { uid: dbUser.id, sub: dbUser.id, email: dbUser.email, name: dbUser.name };
      }
      if (user) {
        token.uid = user.id;
        token.email = user.email;
        token.name = user.name;
        return token;
      }
      // M11.3 — an existing session (server-side reads only; middleware never runs this):
      // void after a password reset, or when the User no longer exists. A void token
      // carries no identity, so every page / API treats the request as signed out.
      // (Pre-M5 tokens carry no uid and are resolved by email, like everywhere else.)
      const where = typeof token.uid === "string" ? { id: token.uid } : typeof token.email === "string" ? { email: normalizeEmail(token.email) } : null;
      if (where) {
        const row = await prisma.user.findUnique({ where, select: { sessionsValidAfter: true } });
        if (!row || sessionIssuedBeforeReset(token.iat, row.sessionsValidAfter)) return {};
      }
      return token;
    },
    session({ session, token }) {
      session.user = {
        id: typeof token.uid === "string" ? token.uid : undefined,
        email: token.email ?? null,
        name: token.name ?? null,
      };
      return session;
    },
    redirect({ url, baseUrl }) {
      return safeAuthRedirect(url, baseUrl);
    },
  },
};

/** The link-intent cookie of this request (then deleted), or null outside a request / when absent. */
async function takeLinkIntentCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const value = jar.get(LINK_INTENT_COOKIE)?.value ?? null;
    if (value) jar.delete({ name: LINK_INTENT_COOKIE, path: "/api/auth" });
    return value;
  } catch {
    return null;
  }
}
