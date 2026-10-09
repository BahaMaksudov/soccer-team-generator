/**
 * M5 — REAL-DATABASE tests for SaaS accounts, email verification,
 * onboarding, invitations (with email delivery) and multi-Organization
 * tenant isolation.
 *
 * Runs only via `npm run test:integration` against the guarded local TEST
 * database (see testDatabaseGuard.ts). Uses the real route handlers,
 * services, Prisma client and tenant resolvers; only NextAuth's session
 * lookup is mocked (a per-test `session` variable). Email goes to the
 * in-memory outbox (NODE_ENV=test); global fetch is replaced by a
 * counting guard, so no Resend/Telegram/other network call can happen.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { authenticateCredentials } from "@/lib/accounts";
import { hashInvitationToken } from "@/lib/invitations";
import { hashToken } from "@/lib/secureToken";
import { getVerificationPreview } from "@/lib/emailVerification";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { listAccessibleTenants, requireTenantContextForSlugs } from "@/lib/tenantContext";
import { setEmailTransportForTests, testOutbox } from "@/lib/email/transport";
import * as signupRoute from "@/app/api/signup/route";
import * as verifyRoute from "@/app/api/verify-email/route";
import * as resendRoute from "@/app/api/account/resend-verification/route";
import * as organizationsRoute from "@/app/api/admin/organizations/route";
import * as invitationsRoute from "@/app/api/admin/o/[organizationSlug]/invitations/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";

const BASE = "https://teambalancepro.test";
const OWNER_EMAIL = "admin@uccne.com";
const OWNER_PASSWORD = "owner-password-123";
const NEE = "new-england-eagles";
const TOKEN_RE = "[A-Za-z0-9_-]{43}";

const post = (body: unknown) =>
  new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = () => new Request("http://itest.local/");
const orgParams = (organizationSlug: string) => ({ params: Promise.resolve({ organizationSlug }) });
const groupParams = (organizationSlug: string, groupSlug: string) => ({ params: Promise.resolve({ organizationSlug, groupSlug }) });

// --- network guard: every fetch is a forbidden external call ---------------
let networkCalls = 0;
const originalFetch = global.fetch;

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
  return u;
}

/** A verified User (as if they had completed email verification). */
async function makeUser(email: string, opts: { verified?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email,
      name: email.split("@")[0],
      passwordHash: bcrypt.hashSync("irrelevant-pw", 4),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    },
  });
}

const workspace = (organizationName: string, groupName: string) => ({
  organizationName,
  groupName,
  sportKey: "soccer",
  timezone: "America/Chicago",
});

const lastEmailTo = (to: string) => [...testOutbox.sent].reverse().find((m) => m.to === to);
const verificationTokenFrom = (to: string) => lastEmailTo(to)?.text.match(new RegExp(`${BASE}/verify-email/(${TOKEN_RE})`))?.[1] ?? "";
const invitationTokenFrom = (to: string) => lastEmailTo(to)?.text.match(new RegExp(`${BASE}/invite/(${TOKEN_RE})`))?.[1] ?? "";

const signup = (name: string, email: string | undefined, password: string, inviteToken?: string) =>
  signupRoute.POST(post({ name, email, password, confirmPassword: password, ...(inviteToken ? { inviteToken } : {}) }));

/** Production-equivalent owner state: owner User (verified by migration #13) → OWNER of New England Eagles → two Groups with data. */
async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const owner = await prisma.user.create({
    data: { email: OWNER_EMAIL, name: "Bahrom Maksudov", passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4), emailVerifiedAt: new Date("2026-09-30T12:00:00Z") },
  });
  const org = await prisma.organization.create({ data: { id: "org-nee", name: "New England Eagles", slug: NEE, plan: "LEGACY" } });
  await prisma.organizationMembership.create({ data: { userId: owner.id, organizationId: org.id, role: "OWNER" } });
  for (const [id, name, slug, team] of [
    ["g-indoor", "Indoor Soccer", "indoor-soccer", "New England Eagles"],
    ["g-tit", "Tenant Isolation Test", "tenant-isolation-test", "Tenant Isolation Test"],
  ]) {
    await prisma.group.create({ data: { id, organizationId: org.id, name, slug, sportKey: "soccer", timezone: "America/New_York" } });
    await prisma.groupSetting.create({ data: { groupId: id, key: "teamName", value: team } });
  }
  for (const [id, groupId, first, last] of [
    ["p1", "g-indoor", "Doni", "Alpha"],
    ["t1", "g-tit", "test", "one"],
    ["t2", "g-tit", "test", "two"],
  ]) {
    await prisma.player.create({ data: { id, groupId, firstName: first, lastName: last, position: "DEFENDER", rating: "GOOD", stamina: 3 } });
  }
  await prisma.teamGeneration.create({ data: { id: "gen-1", groupId: "g-indoor", date: new Date("2026-09-23T00:00:00Z"), teamsJson: "[]" } });
}

async function ownerStateFingerprint() {
  return JSON.stringify({
    orgs: await prisma.organization.findMany({ where: { slug: NEE }, orderBy: { id: "asc" } }),
    memberships: await prisma.organizationMembership.findMany({ where: { organizationId: "org-nee" }, orderBy: { id: "asc" } }),
    groups: await prisma.group.findMany({ where: { organizationId: "org-nee" }, orderBy: { id: "asc" } }),
    settings: await prisma.groupSetting.findMany({ where: { groupId: { in: ["g-indoor", "g-tit"] } }, orderBy: { id: "asc" } }),
    players: await prisma.player.findMany({ where: { groupId: { in: ["g-indoor", "g-tit"] } }, orderBy: { id: "asc" } }),
    gens: await prisma.teamGeneration.findMany({ where: { groupId: { in: ["g-indoor", "g-tit"] } }, orderBy: { id: "asc" } }),
  });
}

async function createInvite(orgSlug: string, email: string, role = "MEMBER") {
  const res = await invitationsRoute.POST(post({ email, role }), orgParams(orgSlug));
  const data = await res.json();
  return { res, data, token: res.ok ? invitationTokenFrom(email.trim().toLowerCase()) : "" };
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
});

beforeEach(async () => {
  session = null;
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@mail.teambalancepro.test>");
  testOutbox.clear();
  setEmailTransportForTests(null);
  await seed();
});

afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe("M5 sign-up, verification and login (real DB)", () => {
  it("sign-up creates an UNVERIFIED, bcrypt-hashed User, a hashed verification token, and emails the link", async () => {
    const res = await signup("New User", "  New.User@Example.COM ", "a-good-password");
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, email: "new.user@example.com", verificationEmailSent: true, next: null });
    expect(text).not.toMatch(/passwordHash|\$2[aby]\$|verify-email/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "new.user@example.com" } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await prisma.organizationMembership.count({ where: { userId: user.id } })).toBe(0);

    const email = lastEmailTo("new.user@example.com")!;
    expect(email.subject).toBe("Verify your email for Team Balance Pro");
    expect(email.from).toBe("Team Balance Pro <no-reply@mail.teambalancepro.test>");
    const token = verificationTokenFrom("new.user@example.com");
    expect(token).toMatch(new RegExp(`^${TOKEN_RE}$`));
    expect(email.text).not.toContain(user.id);

    const rows = await prisma.emailVerificationToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id, email: "new.user@example.com", usedAt: null, tokenHash: hashToken(token) });
    expect(JSON.stringify(rows)).not.toContain(token);
    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttl).toBeGreaterThan(23.9 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 5000);
  });

  it("normal SaaS flow: unverified → tenant access denied → verify → onboarding → own workspace", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    await signInAs("ann@example.com");

    expect((await organizationsRoute.POST(post(workspace("Boston Pickup Soccer", "Wednesday Night Soccer")))).status).toBe(403);
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(403);
    await expect(listAccessibleTenants()).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await prisma.organization.count()).toBe(1);

    const token = verificationTokenFrom("ann@example.com");
    // Viewing the link (what a mail scanner does) never consumes it.
    expect(await getVerificationPreview(token)).toEqual({ status: "valid", email: "ann@example.com" });
    expect(await getVerificationPreview(token)).toEqual({ status: "valid", email: "ann@example.com" });
    expect((await prisma.emailVerificationToken.findFirstOrThrow()).usedAt).toBeNull();

    const v = await verifyRoute.POST(post({ token }));
    expect(v.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "ann@example.com" } })).emailVerifiedAt).not.toBeNull();

    const created = await organizationsRoute.POST(post(workspace("Boston Pickup Soccer", "Wednesday Night Soccer")));
    expect(created.status).toBe(201);
    expect((await playersRoute.GET(get(), groupParams("boston-pickup-soccer", "wednesday-night-soccer"))).status).toBe(200);
    // Verification grants nothing else.
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(404);
  });

  it("verification replay, concurrency, expiry and garbage tokens", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    const token = verificationTokenFrom("ann@example.com");

    const [r1, r2] = await Promise.all([verifyRoute.POST(post({ token })), verifyRoute.POST(post({ token }))]);
    expect([r1.status, r2.status].sort()).toEqual([200, 410]);
    expect((await verifyRoute.POST(post({ token }))).status).toBe(410);
    expect(await getVerificationPreview(token)).toEqual({ status: "used" });

    await signup("Bob", "bob@example.com", "bob-password-1");
    const bobToken = verificationTokenFrom("bob@example.com");
    await prisma.emailVerificationToken.updateMany({ where: { email: "bob@example.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verifyRoute.POST(post({ token: bobToken }))).status).toBe(410);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "bob@example.com" } })).emailVerifiedAt).toBeNull();

    expect((await verifyRoute.POST(post({ token: "x".repeat(43) }))).status).toBe(400);
    expect((await verifyRoute.POST(post({ token: "../../etc" }))).status).toBe(400);
  });

  it("a token is bound to the email it was sent to: after an email change it no longer verifies", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    const token = verificationTokenFrom("ann@example.com");
    await prisma.user.update({ where: { email: "ann@example.com" }, data: { email: "other@example.com" } });
    expect((await verifyRoute.POST(post({ token }))).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "other@example.com" } })).emailVerifiedAt).toBeNull();
  });

  it("resend replaces the previous link; already-verified resend is a safe no-op; unauthenticated → 401", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    const first = verificationTokenFrom("ann@example.com");
    await signInAs("ann@example.com");

    const r = await resendRoute.POST(post({ next: "https://evil.example" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, alreadyVerified: false });
    const second = verificationTokenFrom("ann@example.com");
    expect(second).not.toBe(first);
    expect(lastEmailTo("ann@example.com")!.text).not.toContain("evil");
    expect(await prisma.emailVerificationToken.count({ where: { usedAt: null } })).toBe(1);

    expect((await verifyRoute.POST(post({ token: first }))).status).toBe(400);
    expect((await verifyRoute.POST(post({ token: second }))).status).toBe(200);

    const sentBefore = testOutbox.sent.length;
    expect(await (await resendRoute.POST(post({}))).json()).toEqual({ ok: true, alreadyVerified: true });
    expect(testOutbox.sent.length).toBe(sentBefore);

    session = null;
    expect((await resendRoute.POST(post({}))).status).toBe(401);
  });

  it("concurrent resends leave exactly one live token", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    await signInAs("ann@example.com");
    await Promise.all([resendRoute.POST(post({})), resendRoute.POST(post({})), resendRoute.POST(post({}))]);
    expect(await prisma.emailVerificationToken.count({ where: { usedAt: null } })).toBe(1);
    expect((await verifyRoute.POST(post({ token: verificationTokenFrom("ann@example.com") }))).status).toBe(200);
  });

  it("provider failure at sign-up keeps the account recoverable via resend", async () => {
    testOutbox.failNext = 1;
    const res = await signup("Ann", "ann@example.com", "ann-password-1");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ ok: true, email: "ann@example.com", verificationEmailSent: false, next: null });
    expect(testOutbox.sent).toHaveLength(0);
    expect(await prisma.user.count({ where: { email: "ann@example.com" } })).toBe(1);

    await signInAs("ann@example.com");
    testOutbox.failNext = 1;
    const failedResend = await resendRoute.POST(post({}));
    expect(failedResend.status).toBe(502);
    expect(JSON.stringify(await failedResend.json())).not.toMatch(/resend|503|http/i);

    expect((await resendRoute.POST(post({}))).status).toBe(200);
    expect((await verifyRoute.POST(post({ token: verificationTokenFrom("ann@example.com") }))).status).toBe(200);
  });

  it("duplicate email (any casing) → 409; concurrent duplicate sign-ups create exactly one User", async () => {
    const res = await signup("X", "ADMIN@uccne.com", "a-good-password");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "An account with this email already exists." });

    const results = await Promise.all([signup("A", "race@example.com", "a-good-password"), signup("B", "Race@Example.com", "a-good-password")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: "race@example.com" } })).toBe(1);
  });

  it("server-side validation: bad email, short password, mismatched confirmation, non-JSON", async () => {
    const base = { name: "X", email: "x@example.com", password: "a-good-password", confirmPassword: "a-good-password" };
    expect((await signupRoute.POST(post({ ...base, email: "nope" }))).status).toBe(400);
    expect((await signupRoute.POST(post({ ...base, password: "short", confirmPassword: "short" }))).status).toBe(400);
    expect((await signupRoute.POST(post({ ...base, confirmPassword: "different-pw" }))).status).toBe(400);
    const form = new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=x" });
    expect((await signupRoute.POST(form)).status).toBe(415);
    expect(await prisma.user.count()).toBe(1);
  });

  it("DB-backed login works before verification (identity only); wrong password / unknown email → null", async () => {
    await signup("Ann", "ann@example.com", "ann-password-1");
    const ok = await authenticateCredentials(" ANN@example.com ", "ann-password-1", prisma);
    expect(ok).toEqual({ id: expect.any(String), email: "ann@example.com", name: "Ann" });
    expect(await authenticateCredentials("ann@example.com", "wrong-password", prisma)).toBeNull();
    expect(await authenticateCredentials("ghost@example.com", "ann-password-1", prisma)).toBeNull();
  });
});

describe("M5 central unverified-account policy (real DB)", () => {
  it("an unverified User — even one holding an OWNER membership — reaches no tenant surface", async () => {
    const u = await makeUser("unverified@example.com", { verified: false });
    await prisma.organizationMembership.create({ data: { userId: u.id, organizationId: "org-nee", role: "OWNER" } });
    await signInAs(u.email);

    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(403);
    expect((await playersRoute.POST(post({ firstName: "X", lastName: "Y", position: "DEFENDER", rating: "GOOD" }), groupParams(NEE, "indoor-soccer"))).status).toBe(403);
    expect((await invitationsRoute.GET(get(), orgParams(NEE))).status).toBe(403);
    expect((await invitationsRoute.POST(post({ email: "x@example.com", role: "MEMBER" }), orgParams(NEE))).status).toBe(403);
    expect((await organizationsRoute.POST(post(workspace("Z Org", "G")))).status).toBe(403);
    await expect(requireTenantContextForSlugs({ organizationSlug: NEE, groupSlug: "indoor-soccer" })).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await prisma.player.count()).toBe(3);
    expect(await prisma.organizationInvitation.count()).toBe(0);
  });

  it("verification is read from the database on every request (no stale session state)", async () => {
    const u = await makeUser("bob@example.com");
    await prisma.organizationMembership.create({ data: { userId: u.id, organizationId: "org-nee", role: "ADMIN" } });
    await signInAs(u.email);
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(200);
    await prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: null } });
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(403);
  });
});

describe("M5 onboarding: Organization + first Group (real DB)", () => {
  it("creates Organization, OWNER membership, Group and GroupSetting atomically for the session User", async () => {
    const ann = await makeUser("ann@example.com");
    await signInAs(ann.email);

    const res = await organizationsRoute.POST(post({ ...workspace("Boston Pickup Soccer", "Wednesday Night Soccer"), userId: "someone-else" }));
    expect(res.status).toBe(201);
    expect((await res.json()).href).toBe("/admin/o/boston-pickup-soccer/g/wednesday-night-soccer");

    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: "boston-pickup-soccer" }, include: { memberships: true, groups: { include: { settings: true } } } });
    expect(org.memberships).toEqual([expect.objectContaining({ userId: ann.id, role: "OWNER" })]);
    expect(org.groups).toHaveLength(1);
    expect(org.groups[0]).toMatchObject({ organizationId: org.id, slug: "wednesday-night-soccer", sportKey: "soccer", timezone: "America/Chicago", isActive: true });
    expect(org.groups[0].settings).toEqual([expect.objectContaining({ key: "teamName", value: "Boston Pickup Soccer" })]);
  });

  it("slug collisions get a numeric suffix; the new owner still cannot reach the original Organization", async () => {
    const before = await ownerStateFingerprint();
    const mallory = await makeUser("mallory@example.com");
    await signInAs(mallory.email);

    const res = await organizationsRoute.POST(post(workspace("New England Eagles", "Indoor Soccer")));
    expect(res.status).toBe(201);
    expect((await res.json()).href).toBe("/admin/o/new-england-eagles-2/g/indoor-soccer");
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(404);
    expect((await listAccessibleTenants()).map((o) => o.slug)).toEqual(["new-england-eagles-2"]);
    expect(await ownerStateFingerprint()).toBe(before);
  });

  it("concurrent creations by different Users with the same name both succeed with distinct slugs", async () => {
    const [a, b] = await Promise.all([makeUser("a@example.com"), makeUser("b@example.com")]);
    const [wa, wb] = await Promise.all([
      createOrganizationWorkspace(a.id, workspace("Sunday League", "Main")),
      createOrganizationWorkspace(b.id, workspace("Sunday League", "Main")),
    ]);
    expect(new Set([wa.organization.slug, wb.organization.slug])).toEqual(new Set(["sunday-league", "sunday-league-2"]));
  });

  it("double-submit and retry-after-lost-response return the same workspace — never a duplicate", async () => {
    const ann = await makeUser("ann@example.com");
    await signInAs(ann.email);
    const body = workspace("Boston Pickup Soccer", "Wednesday Night Soccer");
    const [r1, r2] = await Promise.all([organizationsRoute.POST(post(body)), organizationsRoute.POST(post(body))]);
    const r3 = await organizationsRoute.POST(post(body));
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r3.status).toBe(200);
    expect(await prisma.organization.count({ where: { memberships: { some: { userId: ann.id } } } })).toBe(1);
  });

  it("the existing owner can create a second Organization; New England Eagles is untouched", async () => {
    const before = await ownerStateFingerprint();
    await signInAs(OWNER_EMAIL);
    expect((await organizationsRoute.POST(post(workspace("Boston Pickup Soccer", "Wednesday Night Soccer")))).status).toBe(201);
    const orgs = await listAccessibleTenants();
    expect(orgs.map((o) => [o.slug, o.role, o.groups.map((g) => g.slug)]).sort()).toEqual([
      ["boston-pickup-soccer", "OWNER", ["wednesday-night-soccer"]],
      [NEE, "OWNER", ["indoor-soccer", "tenant-isolation-test"]],
    ]);
    expect(await ownerStateFingerprint()).toBe(before);
  });

  it("invalid input is rejected server-side and creates nothing; unauthenticated → 401", async () => {
    await signInAs(OWNER_EMAIL);
    // M7: every registry sport is valid; an unknown sport key is not.
    expect((await organizationsRoute.POST(post({ ...workspace("X Org", "G"), sportKey: "hockey" }))).status).toBe(400);
    expect((await organizationsRoute.POST(post({ ...workspace("X Org", "G"), timezone: "Mars/Base" }))).status).toBe(400);
    session = null;
    expect((await organizationsRoute.POST(post(workspace("X Org", "G")))).status).toBe(401);
    expect(await prisma.organization.count()).toBe(1);
  });
});

describe("M5 tenant security across Organizations (real DB)", () => {
  it("User A ↔ Org A and User B ↔ Org B are mutually isolated; /admin lists only one's own", async () => {
    const [a, b] = await Promise.all([makeUser("usera@example.com"), makeUser("userb@example.com")]);
    await createOrganizationWorkspace(a.id, workspace("Org A", "Group A"));
    await createOrganizationWorkspace(b.id, workspace("Org B", "Group B"));

    await signInAs(a.email);
    expect((await playersRoute.GET(get(), groupParams("org-a", "group-a"))).status).toBe(200);
    expect((await playersRoute.GET(get(), groupParams("org-b", "group-b"))).status).toBe(404);
    expect((await playersRoute.POST(post({ firstName: "X", lastName: "Y", position: "DEFENDER", rating: "GOOD" }), groupParams("org-b", "group-b"))).status).toBe(404);
    expect((await listAccessibleTenants()).map((o) => o.slug)).toEqual(["org-a"]);

    await signInAs(b.email);
    expect((await playersRoute.GET(get(), groupParams("org-b", "group-b"))).status).toBe(200);
    expect((await playersRoute.GET(get(), groupParams("org-a", "group-a"))).status).toBe(404);
    expect((await listAccessibleTenants()).map((o) => o.slug)).toEqual(["org-b"]);
    expect(await prisma.player.count({ where: { group: { slug: "group-b" } } })).toBe(0);
  });

  it("a session whose User.id does not match the email's User is refused (no silent re-binding)", async () => {
    session = { user: { id: "stale-or-forged-id", email: OWNER_EMAIL } };
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(404);
    expect((await organizationsRoute.POST(post(workspace("X Org", "G")))).status).toBe(401);
  });

  it("removing a membership revokes access immediately — nothing role-related is cached in the session", async () => {
    const bob = await makeUser("bob@example.com");
    await prisma.organizationMembership.create({ data: { userId: bob.id, organizationId: "org-nee", role: "ADMIN" } });
    await signInAs(bob.email);
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(200);
    await prisma.organizationMembership.deleteMany({ where: { userId: bob.id } });
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(404);
  });
});

describe("M5 invitations with email delivery (real DB)", () => {
  it("the OWNER's invitation is emailed with an APP_BASE_URL link; only the token hash is stored", async () => {
    await signInAs(OWNER_EMAIL);
    const { res, data, token } = await createInvite(NEE, "  Bob@Example.com ", "ADMIN");
    expect(res.status).toBe(201);
    expect(data.invitation).toMatchObject({ email: "bob@example.com", role: "ADMIN" });

    const email = lastEmailTo("bob@example.com")!;
    expect(email.subject).toBe("You're invited to join New England Eagles on Team Balance Pro");
    expect(email.text).toContain("Bahrom Maksudov invited you to join New England Eagles on Team Balance Pro as ADMIN");
    expect(email.text).toContain(`${BASE}/invite/${token}`);
    expect(email.text).not.toContain("org-nee");

    const row = await prisma.organizationInvitation.findFirstOrThrow();
    expect(row).toMatchObject({ organizationId: "org-nee", email: "bob@example.com", role: "ADMIN", acceptedAt: null });
    expect(row.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("in production the API response never contains the raw token or link (email only)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASE_URL", BASE);
    setEmailTransportForTests(testOutbox); // production would pick Resend; keep it in memory
    await signInAs(OWNER_EMAIL);
    const res = await invitationsRoute.POST(post({ email: "bob@example.com", role: "MEMBER" }), orgParams(NEE));
    const text = await res.text();
    vi.stubEnv("NODE_ENV", "test");
    expect(res.status).toBe(201);
    const token = invitationTokenFrom("bob@example.com");
    expect(token).toMatch(new RegExp(`^${TOKEN_RE}$`));
    expect(JSON.parse(text).invitePath).toBeNull();
    expect(text).not.toContain(token);
    expect(text).not.toContain("/invite/");
  });

  it("provider failure: 502, no invitation left behind, nothing granted, safe message", async () => {
    await signInAs(OWNER_EMAIL);
    testOutbox.failNext = 1;
    const res = await invitationsRoute.POST(post({ email: "bob@example.com", role: "MEMBER" }), orgParams(NEE));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/invite\/|503|resend/i);
    expect(await prisma.organizationInvitation.count()).toBe(0);
    expect(await prisma.organizationMembership.count({ where: { organizationId: "org-nee" } })).toBe(1);

    // Retry works and leaves exactly one live invitation.
    expect((await createInvite(NEE, "bob@example.com")).res.status).toBe(201);
    expect(await prisma.organizationInvitation.count()).toBe(1);
  });

  it("re-inviting supersedes the older pending link (one live invitation per Organization + email)", async () => {
    await signInAs(OWNER_EMAIL);
    const first = (await createInvite(NEE, "bob@example.com")).token;
    const second = (await createInvite(NEE, "bob@example.com", "ADMIN")).token;
    expect(await prisma.organizationInvitation.count()).toBe(1);
    const bob = await makeUser("bob@example.com");
    await signInAs(bob.email);
    expect((await acceptRoute.POST(post({ token: first }))).status).toBe(400);
    expect((await acceptRoute.POST(post({ token: second }))).status).toBe(200);
    expect(await prisma.organizationMembership.findFirstOrThrow({ where: { userId: bob.id } })).toMatchObject({ role: "ADMIN" });
  });

  it("ADMIN and MEMBER roles cannot invite or list members (generic 404); nothing is created or emailed", async () => {
    for (const role of ["ADMIN", "MEMBER"] as const) {
      const u = await makeUser(`${role.toLowerCase()}@example.com`);
      await prisma.organizationMembership.create({ data: { userId: u.id, organizationId: "org-nee", role } });
      await signInAs(u.email);
      expect((await createInvite(NEE, "someone@example.com")).res.status).toBe(404);
      expect((await invitationsRoute.GET(get(), orgParams(NEE))).status).toBe(404);
    }
    expect(await prisma.organizationInvitation.count()).toBe(0);
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("the client cannot choose OWNER, another Organization, or a token", async () => {
    await signInAs(OWNER_EMAIL);
    expect((await invitationsRoute.POST(post({ email: "bob@example.com", role: "OWNER" }), orgParams(NEE))).status).toBe(400);
    const other = await makeUser("otherowner@example.com");
    const otherOrg = await createOrganizationWorkspace(other.id, workspace("Other Org", "G"));
    const res = await invitationsRoute.POST(
      post({ email: "bob@example.com", role: "MEMBER", organizationId: otherOrg.organization.id, tokenHash: "x" }),
      orgParams(NEE)
    );
    expect(res.status).toBe(201);
    const rows = await prisma.organizationInvitation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe("org-nee");
    expect(rows[0].tokenHash).not.toBe("x");
  });

  it("cross-tenant: an OWNER of another Organization cannot invite into, or list, New England Eagles", async () => {
    const other = await makeUser("otherowner@example.com");
    await createOrganizationWorkspace(other.id, workspace("Other Org", "G"));
    await signInAs(other.email);
    expect((await createInvite(NEE, "friend@example.com")).res.status).toBe(404);
    expect((await invitationsRoute.GET(get(), orgParams(NEE))).status).toBe(404);
    expect(await prisma.organizationInvitation.count()).toBe(0);
  });

  it("inviting an existing member is refused (409) and sends nothing", async () => {
    await signInAs(OWNER_EMAIL);
    expect((await createInvite(NEE, OWNER_EMAIL)).res.status).toBe(409);
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("existing verified account: matching email accepts once with the invitation's role; replay is idempotent", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com", "ADMIN");
    const bob = await makeUser("bob@example.com");
    await signInAs(bob.email);

    expect((await acceptRoute.POST(post({ token, organizationId: "evil", role: "OWNER" }))).status).toBe(200);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);
    expect(await prisma.organizationMembership.findMany({ where: { userId: bob.id } })).toEqual([
      expect.objectContaining({ organizationId: "org-nee", role: "ADMIN" }),
    ]);
    expect((await playersRoute.GET(get(), groupParams(NEE, "tenant-isolation-test"))).status).toBe(200);
  });

  it("existing UNVERIFIED account: cannot accept until verified, then returns to the invitation and accepts", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    await signup("Bob", "bob@example.com", "bob-password-1"); // self-signed-up before seeing the invite
    await signInAs("bob@example.com");

    expect((await acceptRoute.POST(post({ token }))).status).toBe(403);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();

    // Resend from the invitation page carries the invitation as the continuation.
    expect((await resendRoute.POST(post({ next: `/invite/${token}` }))).status).toBe(200);
    expect(lastEmailTo("bob@example.com")!.text).toContain(`?next=${encodeURIComponent(`/invite/${token}`)}`);
    expect((await verifyRoute.POST(post({ token: verificationTokenFrom("bob@example.com") }))).status).toBe(200);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();

    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);
    expect(await prisma.organizationMembership.count({ where: { user: { email: "bob@example.com" } } })).toBe(1);
  });

  it("concurrent acceptance by the same User creates exactly one membership", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    const bob = await makeUser("bob@example.com");
    await signInAs(bob.email);
    const results = await Promise.all([acceptRoute.POST(post({ token })), acceptRoute.POST(post({ token }))]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.organizationMembership.count({ where: { userId: bob.id } })).toBe(1);
  });

  it("a different logged-in email is rejected (403) and the invitation stays pending", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    const eve = await makeUser("eve@example.com");
    await signInAs(eve.email);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(403);
    expect(await prisma.organizationMembership.count({ where: { userId: eve.id } })).toBe(0);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();
  });

  it("an already-used token cannot be replayed by anyone else (410)", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    const bob = await makeUser("bob@example.com");
    await signInAs(bob.email);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);
    const eve = await makeUser("eve@example.com");
    await signInAs(eve.email);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(410);
    expect(await prisma.organizationMembership.count({ where: { userId: eve.id } })).toBe(0);
  });

  it("expired and unknown tokens are rejected and grant nothing", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    await prisma.organizationInvitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const bob = await makeUser("bob@example.com");
    await signInAs(bob.email);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(410);
    expect((await acceptRoute.POST(post({ token: "x".repeat(43) }))).status).toBe(400);
    expect(await prisma.organizationMembership.count({ where: { userId: bob.id } })).toBe(0);
  });

  it("invitation and verification tokens are not interchangeable", async () => {
    await signInAs(OWNER_EMAIL);
    const { token: inviteToken } = await createInvite(NEE, "bob@example.com");
    await signup("Bob", undefined, "bob-password-1", inviteToken);
    const verifyToken = verificationTokenFrom("bob@example.com");

    expect((await verifyRoute.POST(post({ token: inviteToken }))).status).toBe(400);
    await signInAs("bob@example.com");
    await prisma.user.update({ where: { email: "bob@example.com" }, data: { emailVerifiedAt: new Date() } });
    expect((await acceptRoute.POST(post({ token: verifyToken }))).status).toBe(400);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();
    expect((await prisma.emailVerificationToken.findFirstOrThrow()).usedAt).toBeNull();
  });

  it("an existing membership is kept as-is (no duplicate, no role change)", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com", "ADMIN");
    const bob = await makeUser("bob@example.com");
    await prisma.organizationMembership.create({ data: { userId: bob.id, organizationId: "org-nee", role: "MEMBER" } });
    await signInAs(bob.email);
    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);
    expect(await prisma.organizationMembership.findMany({ where: { userId: bob.id } })).toEqual([expect.objectContaining({ role: "MEMBER" })]);
  });

  it("unauthenticated acceptance → 401", async () => {
    session = null;
    expect((await acceptRoute.POST(post({ token: "x".repeat(43) }))).status).toBe(401);
  });

  it("new invited User: invitation email forced, stays pending through sign-up AND verification, accepted only by explicit POST", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "carol@example.com");
    session = null;

    const res = await signup("Carol", "attacker@example.com", "carol-password", token);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, email: "carol@example.com", verificationEmailSent: true, next: `/invite/${token}` });
    expect(await prisma.user.findUnique({ where: { email: "attacker@example.com" } })).toBeNull();
    const carol = await prisma.user.findUniqueOrThrow({ where: { email: "carol@example.com" } });
    expect(carol.emailVerifiedAt).toBeNull();
    expect(await prisma.organizationMembership.count({ where: { userId: carol.id } })).toBe(0);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();

    // Unverified: cannot accept.
    await signInAs("carol@example.com");
    expect((await acceptRoute.POST(post({ token }))).status).toBe(403);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();

    // The verification email continues back to the invitation.
    const verifyEmail = lastEmailTo("carol@example.com")!;
    expect(verifyEmail.text).toContain(`?next=${encodeURIComponent(`/invite/${token}`)}`);
    expect((await verifyRoute.POST(post({ token: verificationTokenFrom("carol@example.com") }))).status).toBe(200);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull(); // verification does not consume it

    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);
    expect(await prisma.organizationMembership.findMany({ where: { userId: carol.id } })).toEqual([
      expect.objectContaining({ organizationId: "org-nee", role: "MEMBER" }),
    ]);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedByUserId).toBe(carol.id);

    // The same invitation link cannot create a second account.
    session = null;
    expect((await signup("C2", undefined, "carol-password", token)).status).toBe(400);
  });

  it("invitation sign-up for an email that already has an account fails and leaves the invitation pending", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "dave@example.com");
    await makeUser("dave@example.com");
    session = null;
    expect((await signup("Dave", undefined, "dave-password", token)).status).toBe(409);
    expect((await prisma.organizationInvitation.findFirstOrThrow()).acceptedAt).toBeNull();
    expect(await prisma.organizationMembership.count({ where: { organizationId: "org-nee" } })).toBe(1);
  });

  it("OWNER members view lists members and pending invitations without any token material", async () => {
    await signInAs(OWNER_EMAIL);
    const { token } = await createInvite(NEE, "bob@example.com");
    const res = await invitationsRoute.GET(get(), orgParams(NEE));
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.members).toEqual([{ id: expect.any(String), name: "Bahrom Maksudov", email: OWNER_EMAIL, role: "OWNER" }]);
    expect(data.pendingInvitations).toEqual([expect.objectContaining({ email: "bob@example.com", role: "MEMBER" })]);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/tokenHash|passwordHash/);
  });
});

describe("M5 existing production owner compatibility (real DB)", () => {
  it("migration #13's one-time backfill verifies exactly the Users that already own an Organization", async () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/migrations/20260930120000_m5_saas_accounts_invitations/migration.sql"),
      "utf8"
    );
    const backfill = sql.match(/UPDATE "User"[\s\S]*?;/)?.[0];
    expect(backfill).toBeDefined();
    expect(backfill).not.toMatch(/@|\$2[aby]\$/); // no email/hash literals

    // Pre-M5 state: owner and a non-owner, both unverified (column just added).
    const member = await makeUser("member@example.com", { verified: false });
    const loner = await makeUser("loner@example.com", { verified: false });
    await prisma.organizationMembership.create({ data: { userId: member.id, organizationId: "org-nee", role: "MEMBER" } });
    await prisma.user.updateMany({ data: { emailVerifiedAt: null } });

    await prisma.$executeRawUnsafe(backfill!);

    const users = await prisma.user.findMany({ select: { email: true, emailVerifiedAt: true }, orderBy: { email: "asc" } });
    expect(users.map((u) => [u.email, u.emailVerifiedAt !== null])).toEqual([
      [OWNER_EMAIL, true],
      ["loner@example.com", false],
      ["member@example.com", false],
    ]);
    expect(loner.id).toBeTruthy();
  });

  it("the grandfathered owner signs in through the DB path and keeps access to both existing Groups", async () => {
    const identity = await authenticateCredentials(OWNER_EMAIL, OWNER_PASSWORD, prisma);
    expect(identity).toMatchObject({ email: OWNER_EMAIL, name: "Bahrom Maksudov" });
    session = { user: { id: identity!.id, email: identity!.email } };

    expect(await listAccessibleTenants()).toEqual([
      expect.objectContaining({ slug: NEE, role: "OWNER", groups: [expect.objectContaining({ slug: "indoor-soccer" }), expect.objectContaining({ slug: "tenant-isolation-test" })] }),
    ]);
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(200);
    const tit = await playersRoute.GET(get(), groupParams(NEE, "tenant-isolation-test"));
    expect((await tit.json()).map((p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`).sort()).toEqual(["test one", "test two"]);
  });

  it("a pre-M5 session (email only, no User.id) still resolves to the owner", async () => {
    session = { user: { email: OWNER_EMAIL } };
    expect((await playersRoute.GET(get(), groupParams(NEE, "indoor-soccer"))).status).toBe(200);
  });

  it("env-based credentials are ignored (legacy fallback retired in M5.1); nothing is written", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    vi.stubEnv("ADMIN_EMAIL", OWNER_EMAIL);
    vi.stubEnv("ADMIN_PASSWORD_HASH", bcrypt.hashSync("rotated-env-password", 4));
    expect(await authenticateCredentials(OWNER_EMAIL, "rotated-env-password", prisma)).toBeNull();
    expect(await authenticateCredentials(OWNER_EMAIL, OWNER_PASSWORD, prisma)).toMatchObject({ id: before.id });
    expect(await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } })).toEqual(before);
  });

  it("after the M5 flows there is still exactly one owner User, one New England Eagles, one OWNER membership, two Groups", async () => {
    const before = await ownerStateFingerprint();
    await signInAs(OWNER_EMAIL);
    await organizationsRoute.POST(post(workspace("Boston Pickup Soccer", "Wednesday Night Soccer")));
    const { token } = await createInvite(NEE, "bob@example.com");
    session = null;
    await signup("Bob", undefined, "bob-password-1", token);
    await verifyRoute.POST(post({ token: verificationTokenFrom("bob@example.com") }));
    await signInAs("bob@example.com");
    expect((await acceptRoute.POST(post({ token }))).status).toBe(200);

    expect(await prisma.user.count({ where: { email: OWNER_EMAIL } })).toBe(1);
    expect(await prisma.organization.count({ where: { slug: NEE } })).toBe(1);
    expect(await prisma.organizationMembership.count({ where: { organizationId: "org-nee", role: "OWNER" } })).toBe(1);
    expect(await prisma.group.count({ where: { organizationId: "org-nee" } })).toBe(2);
    const after = JSON.parse(await ownerStateFingerprint());
    const prior = JSON.parse(before);
    expect(after.memberships.filter((m: { role: string }) => m.role === "OWNER")).toEqual(prior.memberships);
    expect({ ...after, memberships: null }).toEqual({ ...prior, memberships: null });
  });
});

describe("M5 network safety", () => {
  it("no network call (Resend, Telegram or otherwise) happened anywhere in this suite", () => {
    expect(networkCalls).toBe(0);
  });
});
