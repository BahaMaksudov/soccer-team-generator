import { describe, it, expect } from "vitest";
import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { authOptions } from "@/lib/authOptions";

describe("authOptions — identity-only session", () => {
  const cb = authOptions.callbacks!;

  it("the JWT carries User.id/email/name from the authorized user — no role, no hash", async () => {
    const token = await cb.jwt!({
      token: { sub: "user-1" } as JWT,
      user: { id: "user-1", email: "a@example.com", name: "A", passwordHash: "$2b$12$secret", role: "OWNER" } as never,
      account: null,
      trigger: "signIn",
    } as never);
    expect(token).toMatchObject({ uid: "user-1", email: "a@example.com", name: "A" });
    expect(JSON.stringify(token)).not.toMatch(/passwordHash|\$2b\$|OWNER/);
  });

  it("the session exposes only id, email, name", async () => {
    const session = (await cb.session!({
      session: { expires: "x", user: { email: "a@example.com" } } as Session,
      token: { uid: "user-1", email: "a@example.com", name: "A", passwordHash: "x" } as JWT,
    } as never)) as Session;
    expect(session.user).toEqual({ id: "user-1", email: "a@example.com", name: "A" });
  });

  it("pre-M5 tokens (no uid) keep working by email, with no id claim", async () => {
    const session = (await cb.session!({
      session: { expires: "x" } as Session,
      token: { sub: "admin", email: "admin@uccne.com", name: "Admin" } as JWT,
    } as never)) as Session;
    expect(session.user).toEqual({ id: undefined, email: "admin@uccne.com", name: "Admin" });
  });

  it("the redirect callback never leaves the app's origin", async () => {
    const base = "https://app.example.com";
    expect(await cb.redirect!({ url: "https://evil.example/x", baseUrl: base })).toBe(`${base}/admin`);
    expect(await cb.redirect!({ url: "/admin/o/a/g/b", baseUrl: base })).toBe(`${base}/admin/o/a/g/b`);
  });
});
