/**
 * M5.1 — REAL-DATABASE tests for authenticated Change Password, and proof
 * that the retired ADMIN_EMAIL/ADMIN_PASSWORD_HASH fallback no longer
 * authenticates anyone (login or Change Password), even if still set.
 *
 * Guarded local TEST database only. Real route handler, services, Prisma
 * client and NextAuth Credentials authorize(); only the NextAuth session
 * lookup is mocked. Legacy env vars are test-local stubs (never real
 * values). global fetch is a counting guard — no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/authOptions";
import { authenticateCredentials, verifyPassword } from "@/lib/accounts";
import * as changeRoute from "@/app/api/account/change-password/route";

const OWNER_EMAIL = "owner@example.test";
const OWNER_DB_PASSWORD = "owner-db-password-1"; // what User.passwordHash holds
const LEGACY_PASSWORD = "legacy-env-password-1"; // what a leftover ADMIN_PASSWORD_HASH would encode
const NEW_PASSWORD = "brand-new-password-1";
const OTHER_EMAIL = "other@example.test";
const OTHER_PASSWORD = "other-password-123";

let legacyHash: string;
let networkCalls = 0;
const originalFetch = global.fetch;
let warn: ReturnType<typeof vi.spyOn>;

const post = (body: unknown) =>
  new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const change = (currentPassword: string, newPassword = NEW_PASSWORD, extra: Record<string, unknown> = {}) =>
  changeRoute.POST(post({ currentPassword, newPassword, confirmPassword: newPassword, ...extra }));

const authMessages = () =>
  (warn.mock.calls as unknown[][]).map((c: unknown[]) => String(c[0])).filter((m: string) => m.startsWith("[auth]"));

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
  return u;
}

/** NextAuth's real Credentials authorize(), as /api/auth/callback/credentials calls it. */
async function nextAuthLogin(email: string, password: string) {
  const provider = authOptions.providers[0] as unknown as {
    options: { authorize: (c: Record<string, string>, req: unknown) => Promise<{ id: string } | null> };
  };
  return provider.options.authorize({ email, password }, {});
}

async function tenantFingerprint() {
  return JSON.stringify({
    users: await prisma.user.findMany({ select: { id: true, email: true, name: true, emailVerifiedAt: true }, orderBy: { id: "asc" } }),
    memberships: await prisma.organizationMembership.findMany({ orderBy: { id: "asc" } }),
    orgs: await prisma.organization.findMany({ orderBy: { id: "asc" } }),
    groups: await prisma.group.findMany({ orderBy: { id: "asc" } }),
    players: await prisma.player.findMany({ orderBy: { id: "asc" } }),
    tokens: await prisma.emailVerificationToken.count(),
    invitations: await prisma.organizationInvitation.count(),
  });
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const owner = await prisma.user.create({
    data: { email: OWNER_EMAIL, name: "Owner", passwordHash: bcrypt.hashSync(OWNER_DB_PASSWORD, 4), emailVerifiedAt: new Date("2026-10-01T00:00:00Z") },
  });
  const other = await prisma.user.create({
    data: { email: OTHER_EMAIL, name: "Other", passwordHash: bcrypt.hashSync(OTHER_PASSWORD, 4), emailVerifiedAt: new Date("2026-10-01T00:00:00Z") },
  });
  const org = await prisma.organization.create({ data: { id: "org-1", name: "Org", slug: "org" } });
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  await prisma.organizationMembership.create({ data: { userId: other.id, organizationId: org.id, role: "MEMBER" } });
  await prisma.group.create({ data: { id: "g-1", organizationId: org.id, name: "G", slug: "g", sportKey: "soccer", timezone: "America/New_York" } });
  await prisma.player.create({ data: { id: "p-1", groupId: "g-1", firstName: "A", lastName: "B", position: "DEFENDER", rating: "GOOD", stamina: 3 } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  legacyHash = bcrypt.hashSync(LEGACY_PASSWORD, 4);
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});

beforeEach(async () => {
  session = null;
  vi.unstubAllEnvs();
  warn?.mockRestore();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await seed();
});

afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("M5.1 Change Password — normal database-authenticated User", () => {
  it("unauthenticated → 401, nothing changes", async () => {
    const before = await tenantFingerprint();
    const hashBefore = (await prisma.user.findUniqueOrThrow({ where: { email: OTHER_EMAIL } })).passwordHash;
    expect((await change(OTHER_PASSWORD)).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: OTHER_EMAIL } })).passwordHash).toBe(hashBefore);
    expect(await tenantFingerprint()).toBe(before);
  });

  it("correct current password → new bcrypt hash; new password works, old does not; nothing else changes", async () => {
    const before = await tenantFingerprint();
    const user = await signInAs(OTHER_EMAIL);

    const res = await change(OTHER_PASSWORD);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toMatch(/\$2[aby]\$|password|hash/i);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toBe(user.passwordHash);
    expect(after.passwordHash).toMatch(/^\$2[aby]\$12\$/); // same cost as sign-up
    expect(after.passwordHash).not.toContain(NEW_PASSWORD);
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await verifyPassword(OTHER_PASSWORD, after.passwordHash)).toBe(false);
    expect(after.email).toBe(user.email);
    expect(after.emailVerifiedAt).toEqual(user.emailVerifiedAt);
    expect(await tenantFingerprint()).toBe(before); // emails, verification, memberships, orgs, groups, players unchanged
    expect(authMessages()).toEqual([]); // normal path, no legacy diagnostics
  });

  it("wrong current password → 400 'Current password is incorrect.' and no change", async () => {
    const user = await signInAs(OTHER_EMAIL);
    const res = await change("not-my-password");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Current password is incorrect." });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
  });

  it("mismatch, too short, and unchanged passwords are rejected with no change", async () => {
    const user = await signInAs(OTHER_EMAIL);
    const mismatch = await changeRoute.POST(post({ currentPassword: OTHER_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: "something-else-1" }));
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(await mismatch.json())).toContain("Passwords do not match.");
    expect((await change(OTHER_PASSWORD, "short")).status).toBe(400);
    expect((await change(OTHER_PASSWORD, OTHER_PASSWORD)).status).toBe(400);
    const nonJson = new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" });
    expect((await changeRoute.POST(nonJson)).status).toBe(415);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
  });

  it("cannot change another User: body userId/email/passwordHash/role are ignored", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    const me = await signInAs(OTHER_EMAIL);
    const res = await change(OTHER_PASSWORD, NEW_PASSWORD, {
      userId: owner.id,
      email: OWNER_EMAIL,
      passwordHash: "$2b$04$forgedforgedforgedforgedforgedforgedforgedforgedforged",
      role: "OWNER",
      emailVerifiedAt: null,
    });
    expect(res.status).toBe(200);
    const ownerAfter = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(ownerAfter).toEqual(owner); // untouched
    const meAfter = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(meAfter.email).toBe(OTHER_EMAIL);
    expect(meAfter.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(NEW_PASSWORD, meAfter.passwordHash)).toBe(true);
    expect(await prisma.organizationMembership.findFirstOrThrow({ where: { userId: me.id } })).toMatchObject({ role: "MEMBER" });
  });

  it("a session bound to a different User.id than its email's User is refused (401)", async () => {
    session = { user: { id: "forged-id", email: OTHER_EMAIL } };
    expect((await change(OTHER_PASSWORD)).status).toBe(401);
  });

  it("an account with no Organization can change its own password", async () => {
    await prisma.user.create({ data: { email: "loner@example.test", name: null, passwordHash: bcrypt.hashSync("loner-password-1", 4) } });
    await signInAs("loner@example.test");
    expect((await change("loner-password-1")).status).toBe(200);
  });
});

describe("M5.1 legacy fallback retired — only User.passwordHash authenticates", () => {
  const stubLegacy = () => {
    vi.stubEnv("ADMIN_EMAIL", OWNER_EMAIL);
    vi.stubEnv("ADMIN_PASSWORD_HASH", legacyHash);
  };

  it("with ADMIN_EMAIL/ADMIN_PASSWORD_HASH still set, the env password no longer logs in (NextAuth authorize)", async () => {
    stubLegacy();
    expect(await nextAuthLogin(OWNER_EMAIL, LEGACY_PASSWORD)).toBeNull();
    expect(await nextAuthLogin(OWNER_EMAIL, OWNER_DB_PASSWORD)).toMatchObject({ email: OWNER_EMAIL });
    expect(authMessages()).toEqual([]);
  });

  it("Change Password does not accept the env password as the current password", async () => {
    stubLegacy();
    const owner = await signInAs(OWNER_EMAIL);
    const res = await change(LEGACY_PASSWORD);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Current password is incorrect." });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash).toBe(owner.passwordHash);
    expect(authMessages()).toEqual([]);
  });

  it("owner changes password with the database password; the new password logs in through authorize() with no fallback", async () => {
    stubLegacy();
    const before = await tenantFingerprint();
    const owner = await signInAs(OWNER_EMAIL);
    expect((await change(OWNER_DB_PASSWORD)).status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await verifyPassword(OWNER_DB_PASSWORD, after.passwordHash)).toBe(false);
    expect(await tenantFingerprint()).toBe(before);

    expect(await nextAuthLogin(OWNER_EMAIL, NEW_PASSWORD)).toMatchObject({ id: owner.id, email: OWNER_EMAIL });
    expect(await nextAuthLogin(OWNER_EMAIL, OWNER_DB_PASSWORD)).toBeNull();
    expect(await nextAuthLogin(OWNER_EMAIL, LEGACY_PASSWORD)).toBeNull();
    expect(await authenticateCredentials(OWNER_EMAIL, NEW_PASSWORD, prisma)).toMatchObject({ id: owner.id });
    expect(authMessages()).toEqual([]);
  });
});

describe("M5.1 network safety", () => {
  it("no network call happened in this suite", () => {
    expect(networkCalls).toBe(0);
  });
});
