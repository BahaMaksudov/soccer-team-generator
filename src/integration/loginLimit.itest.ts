/**
 * M12-A — database-backed credentials sign-in limit, REAL DATABASE (guarded local
 * test DB). NextAuth's real Credentials `authorize` is called with request headers
 * as NextAuth passes them; Google's callbacks are invoked like googleAuth.itest.ts.
 * Upstash is controllable through a spy (unconfigured / allowing / refusing).
 * No network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let upstash: "allow" | "deny" | "outage" = "allow";
vi.mock("@/lib/rateLimit", async (orig) => {
  const real = await orig<typeof import("@/lib/rateLimit")>();
  return {
    ...real,
    // Upstash "outage" = the real client's behavior: it fails OPEN (allows).
    checkLoginRateLimit: vi.fn(async () => ({ allowed: upstash !== "deny" })),
  };
});

import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/authOptions";
import { checkPasswordWithLimit, LOGIN_LIMITS } from "@/lib/loginLimit";
import * as changeRoute from "@/app/api/account/change-password/route";
import { resetPassword } from "@/lib/passwordReset";
import { generateToken, hashToken } from "@/lib/secureToken";

const PW = "correct-password-1";
const users = ["alice", "bob", "carol", "dave"] as const;
const email = (u: string) => `${u}@example.test`;
let networkCalls = 0;
const originalFetch = global.fetch;

type Authorize = (c: Record<string, string>, req: unknown) => Promise<{ id: string } | null>;
const authorize = (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;
/** One credentials sign-in as NextAuth runs it: resolves to "ok" | "invalid" | the thrown error code. */
async function login(who: string, password: string, ip: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  try {
    const u = await authorize({ email: who, password }, { headers: { "x-real-ip": ip, "x-forwarded-for": ip, ...extraHeaders }, method: "POST", body: {}, query: {} });
    return u ? "ok" : "invalid";
  } catch (e) {
    return e instanceof Error ? e.message : "error";
  }
}
const fails = (n: number, who: string, ip: (i: number) => string) => Array.from({ length: n }, (_, i) => login(who, "wrong-password", ip(i)));

async function fingerprint() {
  return JSON.stringify({
    users: await prisma.user.findMany({ orderBy: { id: "asc" }, select: { id: true, passwordHash: true, emailVerifiedAt: true, trialUsedAt: true, sessionsValidAfter: true } }),
    orgs: await prisma.organization.findMany({ orderBy: { id: "asc" } }),
    memberships: await prisma.organizationMembership.findMany({ orderBy: { id: "asc" } }),
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1"); // forwarding headers trusted, as behind Vercel
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  upstash = "allow";
  session = null;
  await prisma.$executeRawUnsafe(`TRUNCATE "LoginAttempt","AccountLinkIntent","OAuthAccount","PasswordResetToken","PasswordResetRequest","OrganizationMembership","Group","Organization","User" RESTART IDENTITY CASCADE`);
  const hash = bcrypt.hashSync(PW, 4);
  await prisma.user.createMany({ data: users.map((u) => ({ id: `u-${u}`, email: email(u), name: u, passwordHash: hash, emailVerifiedAt: new Date("2026-01-01") })) });
  await prisma.organization.create({ data: { id: "org", name: "Org", slug: "org", plan: "FREE", trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 80 * 86_400_000) } });
  await prisma.organizationMembership.create({ data: { userId: "u-alice", organizationId: "org", role: "OWNER" } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
  expect(networkCalls).toBe(0);
});

describe("basic outcomes", () => {
  it("1–3: correct password → user; wrong password and unknown email → the same generic null", async () => {
    expect(await login(email("alice"), PW, "203.0.113.1")).toBe("ok");
    expect(await login(email("alice"), "nope-nope", "203.0.113.1")).toBe("invalid");
    expect(await login("nobody@example.test", PW, "203.0.113.1")).toBe("invalid");
    const rows = await prisma.loginAttempt.findMany();
    expect(rows.map((r) => r.outcome).sort()).toEqual(["FAILURE", "FAILURE", "SUCCESS"]);
    // Only keyed digests: no email, address or password in any row.
    expect(JSON.stringify(rows)).not.toMatch(/example\.test|203\.0\.113|correct-password|nope-nope|\$2[aby]\$/);
  });
});

describe("thresholds", () => {
  it("4: 10 failed checks from one address → that address is refused (even with a correct password); other addresses are not", async () => {
    await Promise.all(users.flatMap((u) => fails(2, email(u), () => "198.51.100.7"))); // 8
    await Promise.all(fails(2, "ghost@example.test", () => "198.51.100.7")); // 10
    expect(await login(email("carol"), PW, "198.51.100.7")).toBe("LoginRateLimited");
    expect(await login(email("carol"), PW, "198.51.100.8")).toBe("ok");
  });

  it("5 + 14: 5 failed checks for one email (any addresses) → refused from a NEW address — identically for an unknown email", async () => {
    for (const who of [email("bob"), "unknown.person@example.test"]) {
      for (let i = 0; i < LOGIN_LIMITS.emailFailures.max; i++) expect(await login(who, "wrong-password", `192.0.2.${i + 1}`)).toBe("invalid");
      expect(await login(who, who === email("bob") ? PW : "anything", "192.0.2.200")).toBe("LoginRateLimited");
    }
  });

  it("6: a successful sign-in resets ONLY that email's failure count (not the address's, not another user's)", async () => {
    for (let i = 0; i < 4; i++) await login(email("alice"), "wrong-password", `192.0.2.${i + 1}`);
    expect(await login(email("alice"), PW, "192.0.2.50")).toBe("ok");
    for (let i = 0; i < 4; i++) expect(await login(email("alice"), "wrong-password", `192.0.2.${i + 60}`)).toBe("invalid"); // fresh budget
    // bob's failures are unaffected by alice's success
    for (let i = 0; i < 5; i++) await login(email("bob"), "wrong-password", `192.0.2.${i + 100}`);
    await login(email("alice"), PW, "192.0.2.50");
    expect(await login(email("bob"), PW, "192.0.2.150")).toBe("LoginRateLimited");
    // and a success doesn't clear the ADDRESS budget either
    for (let i = 0; i < 10; i++) await login(`x${i}@example.test`, "wrong-password", "198.51.100.20");
    expect(await login(email("dave"), PW, "198.51.100.20")).toBe("LoginRateLimited");
  });

  it("7: lockouts end when the failures leave the 15-minute window; refused checks don't extend them", async () => {
    const t0 = new Date("2026-11-01T12:00:00Z");
    const check = (at: Date, ip: string, ok = false) => checkPasswordWithLimit({ email: email("carol"), clientAddress: ip, source: "login", now: at }, async () => ok);
    for (let i = 0; i < 5; i++) await check(new Date(t0.getTime() + i * 1000), `192.0.2.${i}`);
    for (let m = 1; m <= 14; m++) expect(await check(new Date(t0.getTime() + m * 60_000), "192.0.2.99")).toBe("limited"); // hammering while locked
    expect(await check(new Date(t0.getTime() + 15 * 60_000 + 5000), "192.0.2.99", true)).toBe("ok");
  });
});

describe("concurrency, availability, shared addresses, spoofing", () => {
  it("8: a burst of 25 parallel wrong attempts for one email checks the password at most 5 times", async () => {
    let verifies = 0;
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => checkPasswordWithLimit({ email: email("dave"), clientAddress: `203.0.113.${i + 1}`, source: "login" }, async () => (verifies++, false)))
    );
    expect(verifies).toBeLessThanOrEqual(LOGIN_LIMITS.emailFailures.max);
    expect(results.filter((r) => r === "limited").length).toBeGreaterThanOrEqual(20);
  });

  it("9: database unavailable → sign-in fails CLOSED (LoginUnavailable), the password is never checked", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection refused"));
    expect(await login(email("alice"), PW, "203.0.113.1")).toBe("LoginUnavailable");
    expect(compare).not.toHaveBeenCalled();
  });

  it("10: Upstash missing or down (fails open) → the database limit still applies; Upstash refusing → LoginRateLimited", async () => {
    upstash = "outage";
    for (let i = 0; i < 5; i++) await login(email("bob"), "wrong-password", `192.0.2.${i + 1}`);
    expect(await login(email("bob"), PW, "192.0.2.77")).toBe("LoginRateLimited");
    upstash = "deny";
    expect(await login(email("carol"), PW, "192.0.2.78")).toBe("LoginRateLimited");
  });

  it("11: shared address — many successful sign-ins never block it; an owner signing in from a KNOWN address isn't locked out by someone else's failures", async () => {
    for (let r = 0; r < 5; r++) for (const u of users) expect(await login(email(u), PW, "100.64.0.1")).toBe("ok"); // 20 successes, one office IP
    // attacker hammers alice from elsewhere
    for (let i = 0; i < 8; i++) await login(email("alice"), "wrong-password", `192.0.2.${i + 1}`);
    expect(await login(email("alice"), PW, "192.0.2.200")).toBe("LoginRateLimited"); // unknown address: refused
    expect(await login(email("alice"), PW, "100.64.0.1")).toBe("ok"); // her known office address: allowed
  });

  it("12 + 13: IPv6 is bucketed per /64; without a trusted proxy a spoofed X-Forwarded-For can't choose a fresh bucket", async () => {
    for (let i = 0; i < 10; i++) await login(`v6-${i}@example.test`, "wrong-password", `2001:db8:abcd:12::${(i + 1).toString(16)}`);
    expect(await login(email("alice"), PW, "2001:db8:abcd:12:ffff::9")).toBe("LoginRateLimited"); // same /64
    expect(await login(email("alice"), PW, "2001:db8:abcd:13::1")).toBe("ok"); // another /64
    vi.stubEnv("VERCEL", "");
    for (let i = 0; i < 10; i++) await login(`spoof-${i}@example.test`, "wrong-password", `10.9.9.${i + 1}`); // rotating headers
    expect(await login(email("bob"), PW, "10.200.0.1")).toBe("LoginRateLimited"); // all in one untrusted bucket
  });
});

describe("isolation and regressions", () => {
  it("15: Google sign-in is never counted or limited by the credentials limit", async () => {
    for (let i = 0; i < 10; i++) await login(email("alice"), "wrong-password", "203.0.113.5");
    expect(await login(email("alice"), PW, "203.0.113.5")).toBe("LoginRateLimited");
    const before = await prisma.loginAttempt.count();
    const profile = { sub: "g-new", email: "fresh.google@example.test", email_verified: true, name: "Fresh" };
    expect(await authOptions.callbacks!.signIn!({ user: { id: "g-new" }, account: { provider: "google", type: "oauth", providerAccountId: "g-new" }, profile } as never)).toBe(true);
    expect(await prisma.loginAttempt.count()).toBe(before);
  });

  it("16 + 17: password reset works while sign-in is limited, voids older sessions, and restarts that email's count", async () => {
    for (let i = 0; i < 5; i++) await login(email("carol"), "wrong-password", `192.0.2.${i + 1}`);
    expect(await login(email("carol"), PW, "192.0.2.90")).toBe("LoginRateLimited");
    const raw = generateToken();
    await prisma.passwordResetToken.create({ data: { userId: "u-carol", tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await resetPassword(raw, "brand-new-pass-9")).toEqual({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-carol" } })).sessionsValidAfter).toBeInstanceOf(Date);
    expect(await authOptions.callbacks!.jwt!({ token: { uid: "u-carol", email: email("carol"), iat: Math.floor(Date.now() / 1000) - 10 }, account: null } as never)).toEqual({});
    // The reset proved inbox ownership: the email's failure count restarts — the new password works right away, from a new address.
    expect(await login(email("carol"), "brand-new-pass-9", "192.0.2.91")).toBe("ok");
    expect(await login(email("carol"), PW, "192.0.2.92")).toBe("invalid"); // the old password no longer works
  });

  it("change password: the current-password check is limited too (429), counted on the same email", async () => {
    session = { user: { id: "u-dave", email: email("dave") } };
    const post = (currentPassword: string) => changeRoute.POST(new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.30" }, body: JSON.stringify({ currentPassword, newPassword: "another-pass-77", confirmPassword: "another-pass-77" }) }));
    for (let i = 0; i < 5; i++) expect((await post("wrong-current")).status).toBe(400);
    expect((await post(PW)).status).toBe(429);
    expect(await prisma.loginAttempt.count({ where: { source: "change-password" } })).toBe(6);
  });

  it("18: sign-in checks never change users, organizations, memberships or trials", async () => {
    const before = await fingerprint();
    await login(email("alice"), PW, "203.0.113.1");
    for (let i = 0; i < 12; i++) await login(email("alice"), "wrong-password", "203.0.113.1");
    expect(await fingerprint()).toBe(before);
  });

  it("cleanup: non-success rows older than a day and success rows older than 30 days are purged by the next check", async () => {
    const old = new Date(Date.now() - LOGIN_LIMITS.retentionMs - 60_000);
    const ancient = new Date(Date.now() - LOGIN_LIMITS.knownPairMs - 60_000);
    await prisma.loginAttempt.createMany({
      data: [
        { emailHash: "e", ipHash: "i", outcome: "FAILURE", source: "login", createdAt: old },
        { emailHash: "e", ipHash: "i", outcome: "SUCCESS", source: "login", createdAt: old },
        { emailHash: "e", ipHash: "i", outcome: "SUCCESS", source: "login", createdAt: ancient },
      ],
    });
    await login(email("alice"), PW, "203.0.113.1");
    expect((await prisma.loginAttempt.findMany({ where: { emailHash: "e" }, select: { outcome: true } })).map((r) => r.outcome)).toEqual(["SUCCESS"]);
  });
});
