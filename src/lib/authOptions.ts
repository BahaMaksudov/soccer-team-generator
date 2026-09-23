import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import bcrypt from "bcrypt";
import { checkLoginRateLimit } from "@/lib/rateLimit";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Admin Login",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase() ?? "";
        const password = credentials?.password ?? "";

        const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
        const hash = process.env.ADMIN_PASSWORD_HASH ?? "";

        if (!email || !password || !adminEmail || !hash) return null;

        // Rate-limited by the submitted email so a scripted brute force
        // against the single admin account can't run unbounded. See
        // src/lib/rateLimit.ts for activation requirements.
        const { allowed } = await checkLoginRateLimit(email);
        if (!allowed) return null;

        if (email !== adminEmail) return null;

        const ok = await bcrypt.compare(password, hash);
        if (!ok) return null;

        return { id: "admin", name: "Admin", email: adminEmail };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
};
