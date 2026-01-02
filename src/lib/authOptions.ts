import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import bcrypt from "bcrypt";

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

        console.log("LOGIN email input:", JSON.stringify(email));
        console.log("ENV adminEmail:", JSON.stringify(adminEmail));
        console.log("ENV hash length:", (process.env.ADMIN_PASSWORD_HASH ?? "").length);
        console.log("ENV hash starts:", (process.env.ADMIN_PASSWORD_HASH ?? "").slice(0, 7));

        if (!email || !password || !adminEmail || !hash) return null;
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
