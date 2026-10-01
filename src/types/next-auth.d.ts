import "next-auth";
import "next-auth/jwt";

// M5 — identity-only session: User.id (absent on pre-M5 sessions), email, name.
declare module "next-auth" {
  interface Session {
    user?: { id?: string; email?: string | null; name?: string | null };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}
