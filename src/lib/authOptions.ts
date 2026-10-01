import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { authenticateCredentials, normalizeEmail } from "@/lib/accounts";
import { safeAuthRedirect } from "@/lib/safeRedirect";

/**
 * M5 — database-backed Credentials login (src/lib/accounts.ts). The
 * session/JWT carries identity only (User.id + email + name) — never a
 * password hash and never a role: Organization access and roles are
 * re-read from OrganizationMembership on every request
 * (src/lib/tenantContext.ts), so role changes or removed memberships
 * take effect immediately instead of living on in a long-lived token.
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
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, user }) {
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
