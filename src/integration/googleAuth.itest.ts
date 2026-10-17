/**
 * UI-2 — REAL-DATABASE tests for "Continue with Google" account resolution.
 *
 * Guarded local TEST database only. Google itself is never called: the
 * provider boundary is simulated by invoking NextAuth's real callbacks in
 * the order its OAuth callback route does (signIn → jwt → session) with the
 * profile Google would return. Only NextAuth's server-session lookup is
 * mocked. global fetch is a counting guard — no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";
import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// M12-A — the request cookie jar NextAuth's signIn callback reads (the Google link-intent cookie).
const jar = new Map<string, string>();
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), delete: (o: string | { name: string }) => void jar.delete(typeof o === "string" ? o : o.name) }),
}));

import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/authOptions";
import { authenticateCredentials } from "@/lib/accounts";
import { listAccessibleTenants, requireTenantContextForSlugs, resolveSessionUser, TenantContextError } from "@/lib/tenantContext";
import * as changeRoute from "@/app/api/account/change-password/route";
import * as signupRoute from "@/app/api/signup/route";
import * as linkRoute from "@/app/api/account/google-link/route";
import { createGoogleLinkIntent, LINK_INTENT_COOKIE, LINK_INTENT_TTL_MS } from "@/lib/googleAuth";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { resetPassword } from "@/lib/passwordReset";
import { generateToken, hashToken } from "@/lib/secureToken";

const VERIFIED_AT = new Date("2026-10-01T00:00:00Z");
const OWNER_EMAIL = "owner@example.test";
const OWNER_PASSWORD = "owner-password-123";
const MEMBER_EMAIL = "member@example.test";
const MEMBER_PASSWORD = "member-password-123";
const UNVERIFIED_EMAIL = "unverified@example.test";
const UNVERIFIED_PASSWORD = "squatter-password-1";

let networkCalls = 0;
const originalFetch = global.fetch;

const cb = authOptions.callbacks!;
const googleAccount = (sub: string) => ({ provider: "google", type: "oauth", providerAccountId: sub, access_token: "test-only", token_type: "Bearer" });
// One Google account per (normalized) address unless a test passes its own `sub`.
const googleProfile = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `google-sub-${email.trim().toLowerCase()}`,
  email,
  email_verified: true,
  name: "Google Name",
  picture: "https://example.invalid/p.png",
  ...extra,
});

/** NextAuth's OAuth callback route, minus the HTTP exchange with Google. */
async function googleSignIn(profile: ReturnType<typeof googleProfile>) {
  const user = { id: profile.sub, name: profile.name, email: profile.email, image: profile.picture };
  const account = googleAccount(profile.sub);
  const allowed = await cb.signIn!({ user, account, profile } as never);
  if (allowed !== true) return { allowed, token: null, session: null };
  const token = await cb.jwt!({
    token: { name: user.name, email: user.email, picture: user.image, sub: user.id } as JWT,
    user,
    account,
    profile,
    trigger: "signIn",
  } as never);
  const sess = (await cb.session!({ session: { expires: "x" } as Session, token } as never)) as Session;
  return { allowed, token, session: sess };
}

async function nextAuthCredentialsLogin(email: string, password: string) {
  const provider = authOptions.providers[0] as unknown as {
    options: { authorize: (c: Record<string, string>, req: unknown) => Promise<{ id: string } | null> };
  };
  return provider.options.authorize({ email, password }, {});
}

const post = (body: unknown) =>
  new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function identityFingerprint() {
  return JSON.stringify({
    users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
    memberships: await prisma.organizationMembership.findMany({ orderBy: { id: "asc" } }),
    players: await prisma.player.findMany({ select: { id: true, userId: true }, orderBy: { id: "asc" } }),
    tokens: await prisma.emailVerificationToken.findMany({ orderBy: { id: "asc" } }),
    links: await prisma.oAuthAccount.findMany({ orderBy: { id: "asc" }, select: { userId: true, providerAccountId: true } }),
  });
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "LoginAttempt","AccountLinkIntent","OAuthAccount","PasswordResetToken","PasswordResetRequest","EntitlementEvent","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const owner = await prisma.user.create({
    data: { id: "u-owner", email: OWNER_EMAIL, name: "Owner", passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4), emailVerifiedAt: VERIFIED_AT },
  });
  const member = await prisma.user.create({
    data: { id: "u-member", email: MEMBER_EMAIL, name: "Member", passwordHash: bcrypt.hashSync(MEMBER_PASSWORD, 4), emailVerifiedAt: VERIFIED_AT },
  });
  await prisma.user.create({
    data: { id: "u-unverified", email: UNVERIFIED_EMAIL, name: "Squatter", passwordHash: bcrypt.hashSync(UNVERIFIED_PASSWORD, 4) },
  });
  for (const slug of ["org-a", "org-b"]) {
    await prisma.organization.create({ data: { id: slug, name: slug.toUpperCase(), slug, plan: "LEGACY" } });
    await prisma.group.create({ data: { id: `${slug}-g`, organizationId: slug, name: "G", slug: "g", sportKey: "soccer", timezone: "UTC" } });
  }
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: "org-a", role: "OWNER" } });
  await prisma.organizationMembership.create({ data: { userId: member.id, organizationId: "org-a", role: "MEMBER" } });
  await prisma.player.create({
    data: { id: "p-member", groupId: "org-a-g", userId: member.id, firstName: "M", lastName: "P", position: "DEFENDER", rating: "GOOD", stamina: 3 },
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});

beforeEach(async () => {
  session = null;
  jar.clear();
  vi.stubEnv("GOOGLE_CLIENT_ID", "itest-client-id.apps.example");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "itest-client-secret");
  await seed();
});

afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
  expect(networkCalls).toBe(0);
});

describe("Google sign-in — new User", () => {
  it("creates exactly one verified User with no password, no memberships and no role", async () => {
    const before = await prisma.user.count();
    const { allowed, token, session: s } = await googleSignIn(googleProfile("  New.Person@Example.TEST "));
    expect(allowed).toBe(true);
    expect(await prisma.user.count()).toBe(before + 1);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "new.person@example.test" } });
    expect(u.passwordHash).toBeNull();
    expect(u.emailVerifiedAt).toBeInstanceOf(Date);
    expect(u.name).toBe("Google Name");
    expect(await prisma.organizationMembership.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.emailVerificationToken.count({ where: { userId: u.id } })).toBe(0); // no redundant verification email
    // Identity-only token/session bound to the canonical User id (never the Google subject or picture).
    expect(token).toEqual({ uid: u.id, sub: u.id, email: u.email, name: "Google Name" });
    expect(s!.user).toEqual({ id: u.id, email: u.email, name: "Google Name" });
    expect(JSON.stringify(token)).not.toMatch(/google-sub|picture|OWNER|ADMIN|MEMBER/);

    // A second Google sign-in reuses the same User.
    await googleSignIn(googleProfile("new.person@example.test", { name: "Renamed" }));
    expect(await prisma.user.count()).toBe(before + 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name).toBe("Google Name");
  });

  it("follows the normal product rules: verified, zero Organizations (→ onboarding), no access to other tenants", async () => {
    const { session: s } = await googleSignIn(googleProfile("fresh@example.test"));
    session = { user: { id: s!.user!.id!, email: s!.user!.email! } };
    await expect(resolveSessionUser({ email: session.user.email, userId: session.user.id }, prisma)).resolves.toMatchObject({ email: "fresh@example.test" });
    expect(await listAccessibleTenants()).toEqual([]);
    await expect(requireTenantContextForSlugs({ organizationSlug: "org-a", groupSlug: "g" })).rejects.toBeInstanceOf(TenantContextError);
  });

  it("is refused when Google has not verified the email (nothing written)", async () => {
    const before = await identityFingerprint();
    for (const extra of [{ email_verified: false }, { email_verified: "true" }, { email_verified: undefined }]) {
      const { allowed } = await googleSignIn(googleProfile("unverified-at-google@example.test", extra));
      expect(allowed).toBe("/login?error=GoogleEmailUnverified");
    }
    expect(await identityFingerprint()).toBe(before);
  });
});

/** The explicit "Connect Google" flow: intent for `userId` (as POST /api/account/google-link creates it), then the Google callback. */
async function connectGoogle(userId: string, profile: ReturnType<typeof googleProfile>) {
  const { token } = await createGoogleLinkIntent(userId);
  jar.set(LINK_INTENT_COOKIE, token);
  const r = await googleSignIn(profile);
  return { ...r, cookieCleared: !jar.has(LINK_INTENT_COOKIE) };
}

describe("Google sign-in — existing credentials User (M12-A: no automatic linking by email)", () => {
  it("an UNLINKED Google account with a password account's email is refused — nothing written, no session", async () => {
    const before = await identityFingerprint();
    const { allowed, token } = await googleSignIn(googleProfile("MEMBER@example.test"));
    expect(allowed).toBe("/login?error=GoogleLinkRequired");
    expect(token).toBeNull();
    expect(await identityFingerprint()).toBe(before);
    expect(await nextAuthCredentialsLogin(MEMBER_EMAIL, MEMBER_PASSWORD)).toMatchObject({ id: "u-member" });
  });

  it("explicit connect (password-confirmed intent) links THIS Google account to THIS User; later Google sign-ins are the same User with memberships, Player and password intact", async () => {
    const before = await prisma.user.count();
    const c = await connectGoogle("u-member", googleProfile(MEMBER_EMAIL));
    expect(c.allowed).toBe(true);
    expect(c.cookieCleared).toBe(true);
    expect(c.session!.user).toEqual({ id: "u-member", email: MEMBER_EMAIL, name: "Member" });
    expect(await prisma.oAuthAccount.findMany({ select: { userId: true, providerAccountId: true, emailAtLink: true } })).toEqual([{ userId: "u-member", providerAccountId: `google-sub-${MEMBER_EMAIL}`, emailAtLink: MEMBER_EMAIL }]);
    const again = await googleSignIn(googleProfile(MEMBER_EMAIL, { name: "Other Name" }));
    expect(again.session!.user).toEqual({ id: "u-member", email: MEMBER_EMAIL, name: "Member" });
    expect(await prisma.user.count()).toBe(before);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "p-member" } })).userId).toBe("u-member");
    expect(await nextAuthCredentialsLogin(MEMBER_EMAIL, MEMBER_PASSWORD)).toMatchObject({ id: "u-member" });
  });

  it("the linked identity is the Google account id, not the email: another Google account with the same email is refused", async () => {
    await connectGoogle("u-member", googleProfile(MEMBER_EMAIL));
    expect((await googleSignIn(googleProfile(MEMBER_EMAIL, { sub: "some-other-google-account" }))).allowed).toBe("/login?error=GoogleLinkRequired");
  });

  it("connect is refused (back on the Account page, still signed in) for: a different Google email, an expired / reused / unknown intent, a Google account linked elsewhere, a second Google account", async () => {
    const r1 = await connectGoogle("u-member", googleProfile("someone.else@example.test"));
    expect(r1.allowed).toBe("/account/security?googleError=GoogleEmailMismatch");
    expect(await prisma.user.count({ where: { email: "someone.else@example.test" } })).toBe(0);

    const { token } = await createGoogleLinkIntent("u-member", new Date(Date.now() - LINK_INTENT_TTL_MS - 1000));
    jar.set(LINK_INTENT_COOKIE, token);
    expect((await googleSignIn(googleProfile(MEMBER_EMAIL))).allowed).toBe("/account/security?googleError=GoogleLinkExpired");
    jar.set(LINK_INTENT_COOKIE, generateToken());
    expect((await googleSignIn(googleProfile(MEMBER_EMAIL))).allowed).toBe("/account/security?googleError=GoogleLinkExpired");

    const ok = await connectGoogle("u-member", googleProfile(MEMBER_EMAIL));
    expect(ok.allowed).toBe(true);
    const used = await prisma.accountLinkIntent.findFirstOrThrow({ where: { userId: "u-member", usedAt: { not: null } }, orderBy: { createdAt: "desc" } });
    expect(used.tokenHash).toMatch(/^[0-9a-f]{64}$/); // only the hash is stored
    // The member's Google account can't be connected to the owner (same sub), nor a second one to the member.
    expect((await connectGoogle("u-owner", googleProfile(OWNER_EMAIL, { sub: `google-sub-${MEMBER_EMAIL}` }))).allowed).toBe("/account/security?googleError=GoogleAlreadyLinked");
    expect((await connectGoogle("u-member", googleProfile(MEMBER_EMAIL, { sub: "second-google" }))).allowed).toBe("/account/security?googleError=GoogleAlreadyLinked");
    expect(await prisma.oAuthAccount.count()).toBe(1);
  });

  it("authorization stays membership-driven: a linked Google session gets the DB role, never one from Google", async () => {
    for (const [id, email, role] of [["u-member", MEMBER_EMAIL, "MEMBER"], ["u-owner", OWNER_EMAIL, "OWNER"]] as const) {
      await connectGoogle(id, googleProfile(email));
      const { session: s } = await googleSignIn(googleProfile(email, { hd: "example.test", role: "OWNER", groups: ["admins"] }));
      session = { user: { id: s!.user!.id!, email: s!.user!.email! } };
      const tenants = await listAccessibleTenants();
      expect(tenants.map((t) => [t.slug, t.role])).toEqual([["org-a", role]]);
      await expect(requireTenantContextForSlugs({ organizationSlug: "org-b", groupSlug: "g" })).rejects.toBeInstanceOf(TenantContextError);
    }
  });

  it("an existing UNVERIFIED account is never linked or verified by Google (pre-registration takeover guard)", async () => {
    const before = await identityFingerprint();
    const { allowed, token } = await googleSignIn(googleProfile(UNVERIFIED_EMAIL));
    expect(allowed).toBe("/login?error=AccountEmailUnverified");
    expect(token).toBeNull();
    expect(await identityFingerprint()).toBe(before);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: UNVERIFIED_EMAIL } })).emailVerifiedAt).toBeNull();
  });

  it("credentials sign-up for an email that already has a Google-only account is EMAIL_TAKEN (no second User)", async () => {
    await googleSignIn(googleProfile("taken@example.test"));
    const res = await signupRoute.POST(post({ name: "X", email: "taken@example.test", password: "password-1234", confirmPassword: "password-1234" }));
    expect(res.status).toBe(409);
    expect(await prisma.user.count({ where: { email: "taken@example.test" } })).toBe(1);
  });
});

describe("OAuth-only User (no password)", () => {
  it("can never sign in with a password, and Change Password is refused without writing", async () => {
    const { session: s } = await googleSignIn(googleProfile("oauth.only@example.test"));
    for (const pw of ["", "x", "password-1234", "null", "undefined"]) {
      expect(await authenticateCredentials("oauth.only@example.test", pw)).toBeNull();
      expect(await nextAuthCredentialsLogin("oauth.only@example.test", pw)).toBeNull();
    }
    session = { user: { id: s!.user!.id!, email: s!.user!.email! } };
    const res = await changeRoute.POST(post({ currentPassword: "anything-1", newPassword: "new-password-1", confirmPassword: "new-password-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/signs in with Google/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "oauth.only@example.test" } })).passwordHash).toBeNull();
  });
});

describe("credentials behavior unchanged", () => {
  it("credential sign-in for an existing user works; wrong password / unknown email are generic null", async () => {
    expect(await nextAuthCredentialsLogin(OWNER_EMAIL, OWNER_PASSWORD)).toMatchObject({ id: "u-owner", email: OWNER_EMAIL });
    expect(await nextAuthCredentialsLogin(OWNER_EMAIL, "wrong-password")).toBeNull();
    expect(await nextAuthCredentialsLogin("nobody@example.test", OWNER_PASSWORD)).toBeNull();
    // The credentials jwt path still takes identity from the authorized user.
    const token = await cb.jwt!({ token: {} as JWT, user: { id: "u-owner", email: OWNER_EMAIL, name: "Owner" }, account: { provider: "credentials", type: "credentials" } } as never);
    expect(token).toMatchObject({ uid: "u-owner", email: OWNER_EMAIL, name: "Owner" });
    expect(await cb.signIn!({ user: { id: "u-owner" }, account: { provider: "credentials", type: "credentials" } } as never)).toBe(true);
  });

  it("credentials sign-up still creates an UNVERIFIED User with a bcrypt hash and a verification token", async () => {
    const res = await signupRoute.POST(post({ name: "New", email: "cred.new@example.test", password: "password-1234", confirmPassword: "password-1234" }));
    expect(res.status).toBe(201);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "cred.new@example.test" } });
    expect(u.emailVerifiedAt).toBeNull();
    expect(u.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await prisma.emailVerificationToken.count({ where: { userId: u.id } })).toBe(1);
    session = { user: { id: u.id, email: u.email } };
    await expect(listAccessibleTenants()).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });
});

describe("M12-A — legacy Google-only accounts, concurrency, trial, sessions, connect/disconnect API", () => {
  it("a Google-only account from before M12-A (no password, no link) is linked once on its next sign-in", async () => {
    await prisma.user.create({ data: { id: "u-legacy-google", email: "legacy.google@example.test", name: "LG", passwordHash: null, emailVerifiedAt: VERIFIED_AT } });
    const { allowed, session: s } = await googleSignIn(googleProfile("legacy.google@example.test"));
    expect(allowed).toBe(true);
    expect(s!.user!.id).toBe("u-legacy-google");
    expect(await prisma.oAuthAccount.count({ where: { userId: "u-legacy-google" } })).toBe(1);
  });

  it("concurrent first sign-ins with one Google account create exactly one User and one link", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => googleSignIn(googleProfile("race@example.test"))));
    expect(results.every((r) => r.allowed === true)).toBe(true);
    expect(new Set(results.map((r) => r.session!.user!.id)).size).toBe(1);
    expect(await prisma.user.count({ where: { email: "race@example.test" } })).toBe(1);
    expect(await prisma.oAuthAccount.count()).toBe(1);
  });

  it("trial: a new Google User's first organization gets the one trial; linking never grants another", async () => {
    const { session: s } = await googleSignIn(googleProfile("trial.google@example.test"));
    const ws = await createOrganizationWorkspace(s!.user!.id!, { organizationName: "G Club", groupName: "Mon", sportKey: "soccer", timezone: "UTC" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: ws.organization.id } })).trialEndsAt).toBeInstanceOf(Date);
    // An existing account that already used its trial connects Google: trialUsedAt untouched.
    await prisma.user.update({ where: { id: "u-owner" }, data: { trialUsedAt: VERIFIED_AT } });
    await connectGoogle("u-owner", googleProfile(OWNER_EMAIL));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } })).trialUsedAt).toEqual(VERIFIED_AT);
  });

  it("a password reset voids sessions created through Google too", async () => {
    await connectGoogle("u-owner", googleProfile(OWNER_EMAIL));
    const { token } = await googleSignIn(googleProfile(OWNER_EMAIL));
    const issuedBefore = { ...token!, iat: Math.floor(Date.now() / 1000) - 5 };
    const raw = generateToken();
    await prisma.passwordResetToken.create({ data: { userId: "u-owner", tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await resetPassword(raw, "brand-new-pass-1")).toEqual({ ok: true });
    expect(await cb.jwt!({ token: issuedBefore, account: null } as never)).toEqual({});
  });

  it("POST /api/account/google-link: session + correct password → single-use intent in an httpOnly cookie scoped to /api/auth; wrong password / Google-only / unverified are refused", async () => {
    session = { user: { id: "u-owner", email: OWNER_EMAIL } };
    expect((await linkRoute.POST(post({ currentPassword: "wrong" }))).status).toBe(400);
    expect(await prisma.accountLinkIntent.count()).toBe(0);
    const res = await linkRoute.POST(post({ currentPassword: OWNER_PASSWORD }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${LINK_INTENT_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(await prisma.accountLinkIntent.count({ where: { userId: "u-owner", usedAt: null } })).toBe(1);

    await googleSignIn(googleProfile("google.only@example.test"));
    const g = await prisma.user.findUniqueOrThrow({ where: { email: "google.only@example.test" } });
    session = { user: { id: g.id, email: g.email } };
    expect((await linkRoute.POST(post({ currentPassword: "x" }))).status).toBe(400);
    session = { user: { id: "u-unverified", email: UNVERIFIED_EMAIL } };
    expect((await linkRoute.POST(post({ currentPassword: UNVERIFIED_PASSWORD }))).status).toBe(403);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    session = { user: { id: "u-owner", email: OWNER_EMAIL } };
    expect((await linkRoute.POST(post({ currentPassword: OWNER_PASSWORD }))).status).toBe(404); // Google not configured
  });

  it("DELETE /api/account/google-link: password required; removes the link and ends every session; Google sign-in is then refused again", async () => {
    await connectGoogle("u-owner", googleProfile(OWNER_EMAIL));
    session = { user: { id: "u-owner", email: OWNER_EMAIL } };
    const del = (body: unknown) => linkRoute.DELETE(new Request("http://itest.local/", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    expect((await del({ currentPassword: "wrong" })).status).toBe(400);
    expect(await prisma.oAuthAccount.count()).toBe(1);
    expect((await del({ currentPassword: OWNER_PASSWORD })).status).toBe(200);
    expect(await prisma.oAuthAccount.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } })).sessionsValidAfter).toBeInstanceOf(Date);
    expect((await googleSignIn(googleProfile(OWNER_EMAIL))).allowed).toBe("/login?error=GoogleLinkRequired");
    expect((await del({ currentPassword: OWNER_PASSWORD })).status).toBe(404);
  });

  it("redirects never leave the app's origin", async () => {
    const base = "https://teambalancepro.example";
    expect(await cb.redirect!({ url: "https://evil.example/steal", baseUrl: base })).toBe(`${base}/admin`);
    expect(await cb.redirect!({ url: "//evil.example", baseUrl: base })).toBe(`${base}/admin`);
    expect(await cb.redirect!({ url: "/account/security?google=connected", baseUrl: base })).toBe(`${base}/account/security?google=connected`);
  });
});
