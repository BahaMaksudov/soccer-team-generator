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

import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/authOptions";
import { authenticateCredentials } from "@/lib/accounts";
import { listAccessibleTenants, requireTenantContextForSlugs, resolveSessionUser, TenantContextError } from "@/lib/tenantContext";
import * as changeRoute from "@/app/api/account/change-password/route";
import * as signupRoute from "@/app/api/signup/route";

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
const googleProfile = (email: string, extra: Record<string, unknown> = {}) => ({
  sub: `google-sub-${email}`,
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
  });
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
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

describe("Google sign-in — existing credentials User (account linking)", () => {
  it("signs in as the SAME User: no duplicate, memberships, Player.userId, password and name preserved", async () => {
    const before = await identityFingerprint();
    const { allowed, session: s } = await googleSignIn(googleProfile("MEMBER@example.test"));
    expect(allowed).toBe(true);
    expect(s!.user).toEqual({ id: "u-member", email: MEMBER_EMAIL, name: "Member" });
    expect(await identityFingerprint()).toBe(before); // nothing written at all
    expect(await prisma.user.count({ where: { email: MEMBER_EMAIL } })).toBe(1);

    // Password login keeps working exactly as before.
    expect(await nextAuthCredentialsLogin(MEMBER_EMAIL, MEMBER_PASSWORD)).toMatchObject({ id: "u-member" });
  });

  it("authorization stays membership-driven: the Google session gets the DB role, never one from Google", async () => {
    for (const [email, role] of [[MEMBER_EMAIL, "MEMBER"], [OWNER_EMAIL, "OWNER"]] as const) {
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
