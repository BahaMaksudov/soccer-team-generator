import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { authenticateCredentials, normalizeEmail } from "@/lib/accounts";
import { safeAuthRedirect } from "@/lib/safeRedirect";
import { GOOGLE_PROVIDER_ID, googleAuthConfig, googleSessionUser, resolveGoogleSignIn } from "@/lib/googleAuth";

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
      const result = await resolveGoogleSignIn(profile);
      return result.ok ? true : `/login?error=${result.code}`;
    },
    async jwt({ token, user, account, profile }) {
      if (user && account?.provider === GOOGLE_PROVIDER_ID) {
        // Never the Google subject id or picture: the canonical User only.
        const dbUser = await googleSessionUser(profile);
        return { uid: dbUser.id, sub: dbUser.id, email: dbUser.email, name: dbUser.name };
      }
      if (user) {
        token.uid = user.id;
        token.email = user.email;
        token.name = user.name;
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
