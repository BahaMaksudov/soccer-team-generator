/**
 * Phase 1 — Organization ownership allowance, REAL DATABASE (guarded local
 * test DB only). No Stripe, Telegram, email or OpenAI calls: billing state is
 * seeded as BillingSubscription rows (the local projection the app reads).
 *
 * Rules: 1 owned Organization by default; 2 while one owned Organization is
 * paid Pro (active / past_due subscription — never "trialing"), complimentary
 * Pro or Legacy; never 3. The second starts on Free with no trial. Limits only
 * gate creation; ADMIN/MEMBER memberships never use the allowance.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as organizationsRoute from "@/app/api/admin/organizations/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import AdminEntryPage from "@/app/admin/page";
import OnboardingPage from "@/app/onboarding/page";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { listAccessibleTenants } from "@/lib/tenantContext";
import { OwnershipLimitError, ownershipAllowance, planSummary, SECOND_ORGANIZATION_NOTE } from "@/lib/entitlements";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;

let otherNetwork = 0;
const originalFetch = global.fetch;

type Plan = "FREE" | "TRIAL" | "EXPIRED_TRIAL" | "PRO" | "COMP" | "LEGACY";
const users = ["free", "trial", "paid", "pastdue", "stripetrial", "rawpro", "canceled", "comp", "legacy", "over", "invited", "stranger"] as const;

async function seedOrg(id: string, plan: Plan, ownerId: string | null, opts: { subscription?: string } = {}) {
  const base = plan === "TRIAL" || plan === "EXPIRED_TRIAL" ? "FREE" : plan;
  const trialEndsAt = plan === "TRIAL" ? new Date(Date.now() + 30 * DAY_MS) : plan === "EXPIRED_TRIAL" ? new Date(Date.now() - DAY_MS) : null;
  await prisma.organization.create({ data: { id, name: `Org ${id}`, slug: id, plan: base, trialEndsAt, stripeCustomerId: opts.subscription ? `cus_${id}` : null } });
  await prisma.group.create({ data: { id: `${id}-g`, organizationId: id, name: `${id} group`, slug: `${id}-g`, sportKey: "soccer", timezone: "UTC" } });
  if (ownerId) await prisma.organizationMembership.create({ data: { userId: ownerId, organizationId: id, role: "OWNER" } });
  if (opts.subscription) {
    await prisma.billingSubscription.create({
      data: { organizationId: id, stripeSubscriptionId: `sub_${id}`, stripeCustomerId: `cus_${id}`, status: opts.subscription, livemode: false, lastSyncedAt: new Date() },
    });
  }
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "StripeEvent","BillingCheckoutSession","BillingSubscription","EntitlementEvent","AiUsage","MatchSchedule","Match","CommunityPlayer","Community","Player","GroupSetting","Group","OrganizationMembership","OrganizationInvitation","EmailVerificationToken","Organization","User" RESTART IDENTITY CASCADE`
  );
  // trialUsedAt is set for owners who already had their first Organization (as onboarding would have done).
  await prisma.user.createMany({
    data: users.map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED, trialUsedAt: n === "invited" || n === "stranger" || n === "legacy" ? null : VERIFIED })),
  });
  await seedOrg("free", "EXPIRED_TRIAL", "u-free");
  await seedOrg("trial", "TRIAL", "u-trial");
  await seedOrg("paid", "PRO", "u-paid", { subscription: "active" });
  await seedOrg("pastdue", "PRO", "u-pastdue", { subscription: "past_due" });
  await seedOrg("stripetrial", "PRO", "u-stripetrial", { subscription: "trialing" });
  await seedOrg("rawpro", "PRO", "u-rawpro");
  await seedOrg("canceled", "FREE", "u-canceled", { subscription: "canceled" });
  await seedOrg("comp", "COMP", "u-comp");
  await seedOrg("legacy", "LEGACY", "u-legacy");
  // An owner already ABOVE the allowance (three Free Organizations from before Phase 1).
  for (const id of ["over-a", "over-b", "over-c"]) await seedOrg(id, "FREE", "u-over");
  // u-invited is ADMIN of two Organizations and MEMBER of a third; owns none.
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-invited", organizationId: "paid", role: "ADMIN" },
      { userId: "u-invited", organizationId: "comp", role: "ADMIN" },
      { userId: "u-invited", organizationId: "legacy", role: "MEMBER" },
    ],
  });
}

const ws = (user: string, name: string, now?: Date) => createOrganizationWorkspace(`u-${user}`, { organizationName: name, groupName: "Mondays", sportKey: "soccer", timezone: "UTC" }, now);
const ownedCount = (user: string) => prisma.organizationMembership.count({ where: { userId: `u-${user}`, role: "OWNER" } });
const body = (organizationName: string) =>
  new Request("http://itest.local/api/admin/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationName, groupName: "Mondays", sportKey: "soccer", timezone: "UTC" }) });
const signIn = (user: string) => void (session = { user: { id: `u-${user}`, email: `${user}@example.test` } });
const post = async (user: string, organizationName: string) => {
  signIn(user);
  const res = await organizationsRoute.POST(body(organizationName));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const render = async (page: () => Promise<ReactElement>) => renderToStaticMarkup(await page());

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    otherNetwork++;
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
});

describe("Phase 1 — who may create a second Organization", () => {
  it("Free owner: refused (409 OWNERSHIP_LIMIT, own counts only, no billing details), nothing created", async () => {
    const r = await post("free", "Second Club");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      code: "OWNERSHIP_LIMIT",
      owned: 1,
      allowed: 1,
      error: "You already own 1 organization. A second organization is available when an organization you own is on paid Pro, complimentary Pro or Early Access. You can still join other organizations when you're invited.",
    });
    expect(JSON.stringify(r.body)).not.toMatch(/sub_|cus_|stripe|Org free/i);
    expect(await ownedCount("free")).toBe(1);
    expect(await prisma.organization.count({ where: { name: "Second Club" } })).toBe(0);
  });

  it("introductory trial owner: refused", async () => {
    expect((await post("trial", "Second Club")).status).toBe(409);
    expect(await ownedCount("trial")).toBe(1);
  });

  it("paid Pro: needs a PAID subscription — active or past_due (payment grace); not a Stripe 'trialing' one, not a raw PRO value, not a canceled one", async () => {
    expect(await ownershipAllowance("u-paid")).toEqual({ owned: 1, allowed: 2, canCreate: true, qualifiedBy: "PAID_PRO" });
    expect(await ownershipAllowance("u-pastdue")).toMatchObject({ allowed: 2, qualifiedBy: "PAID_PRO" });
    for (const u of ["stripetrial", "rawpro", "canceled"]) expect(await ownershipAllowance(`u-${u}`), u).toEqual({ owned: 1, allowed: 1, canCreate: false, qualifiedBy: null });
    expect((await post("paid", "Paid Second")).status).toBe(201);
    expect((await post("pastdue", "Past Due Second")).status).toBe(201);
    for (const u of ["stripetrial", "rawpro", "canceled"]) expect((await post(u, `${u} Second`)).status, u).toBe(409);
  });

  it("complimentary Pro and Legacy / Early Access owners may create a second one", async () => {
    expect(await ownershipAllowance("u-comp")).toMatchObject({ allowed: 2, qualifiedBy: "COMP" });
    expect(await ownershipAllowance("u-legacy")).toMatchObject({ allowed: 2, qualifiedBy: "LEGACY" });
    expect((await post("comp", "Comp Second")).status).toBe(201);
    expect((await post("legacy", "Legacy Second")).status).toBe(201);
  });

  it("nobody can create a third Organization", async () => {
    for (const u of ["paid", "comp", "legacy"]) {
      expect((await post(u, `${u} Second`)).status, u).toBe(201);
      const third = await post(u, `${u} Third`);
      expect(third.status, u).toBe(409);
      expect(third.body).toMatchObject({ code: "OWNERSHIP_LIMIT", owned: 2, allowed: 2 });
      expect(third.body.error).toMatch(/^You already own 2 organizations\. An account can own at most 2 organizations\./);
      expect(await ownedCount(u)).toBe(2);
    }
    // Owning two qualifying Organizations still means at most 2.
    await prisma.organization.update({ where: { slug: "comp-second" }, data: { plan: "COMP" } });
    expect(await ownershipAllowance("u-comp")).toMatchObject({ owned: 2, allowed: 2, canCreate: false });
  });

  it("the second Organization starts on Free: no trial, nothing inherited, no entitlement event; the first is untouched", async () => {
    for (const u of ["paid", "comp", "legacy"]) {
      const before = await prisma.organization.findUniqueOrThrow({ where: { id: u } });
      const second = await ws(u, `${u} Second`);
      expect(await prisma.organization.findUniqueOrThrow({ where: { id: second.organization.id } }), u).toMatchObject({ plan: "FREE", trialStartedAt: null, trialEndsAt: null, stripeCustomerId: null });
      expect((await planSummary(second.organization.id)).plan, u).toBe("FREE");
      expect(await prisma.entitlementEvent.count({ where: { organizationId: second.organization.id } })).toBe(0);
      expect(await prisma.billingSubscription.count({ where: { organizationId: second.organization.id } })).toBe(0);
      expect(await prisma.organization.findUniqueOrThrow({ where: { id: u } })).toEqual(before);
    }
    // u-legacy had never used a trial: creating the second Organization does not use it up either.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-legacy" } })).trialUsedAt).toBeNull();
  });
});

describe("Phase 1 — first Organization and trial eligibility are preserved", () => {
  it("an invited ADMIN / MEMBER of three Organizations owns none: their FIRST owned Organization gets the 90-day trial", async () => {
    expect(await ownershipAllowance("u-invited")).toEqual({ owned: 0, allowed: 1, canCreate: true, qualifiedBy: null });
    const now = new Date();
    const first = await ws("invited", "Invited Own Club", now);
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: first.organization.id } })).toMatchObject({ plan: "FREE", trialStartedAt: now });
    expect((await planSummary(first.organization.id, now)).plan).toBe("TRIAL");
    // Owning that trial Organization does not unlock a second one — and the memberships are untouched.
    expect((await post("invited", "Invited Second")).status).toBe(409);
    expect(await prisma.organizationMembership.findMany({ where: { userId: "u-invited", role: { not: "OWNER" } }, select: { organizationId: true, role: true }, orderBy: { organizationId: "asc" } })).toEqual([
      { organizationId: "comp", role: "ADMIN" },
      { organizationId: "legacy", role: "MEMBER" },
      { organizationId: "paid", role: "ADMIN" },
    ]);
  });

  it("a User who already used their trial gets no second trial on a first owned Organization (existing safeguard)", async () => {
    await prisma.user.update({ where: { id: "u-stranger" }, data: { trialUsedAt: VERIFIED } });
    const first = await ws("stranger", "Stranger Club");
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: first.organization.id } })).toMatchObject({ trialEndsAt: null });
  });
});

describe("Phase 1 — concurrency and idempotency", () => {
  it("concurrent requests respect the cap: 5 parallel creations by a COMP owner → exactly one; by a new User → exactly one", async () => {
    const comp = await Promise.allSettled(["A", "B", "C", "D", "E"].map((n) => ws("comp", `Comp Club ${n}`)));
    expect(comp.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(comp.filter((r) => r.status === "rejected" && r.reason instanceof OwnershipLimitError)).toHaveLength(4);
    expect(await ownedCount("comp")).toBe(2);

    const fresh = await Promise.allSettled(["A", "B", "C"].map((n) => ws("stranger", `Stranger Club ${n}`)));
    expect(fresh.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await ownedCount("stranger")).toBe(1);
  });

  it("a repeated identical request returns the workspace it created (200) — never a false limit error, even at the cap", async () => {
    signIn("stranger");
    const [r1, r2] = await Promise.all([organizationsRoute.POST(body("Stranger FC")), organizationsRoute.POST(body("Stranger FC"))]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect((await organizationsRoute.POST(body("Stranger FC"))).status).toBe(200);
    expect((await organizationsRoute.POST(body("Another FC"))).status).toBe(409);
    expect(await ownedCount("stranger")).toBe(1);
    // At the cap of 2: replaying the second creation still returns it.
    expect((await post("legacy", "Legacy Second")).status).toBe(201);
    expect((await post("legacy", "Legacy Second")).status).toBe(200);
    expect(await ownedCount("legacy")).toBe(2);
  });
});

describe("Phase 1 — existing access is never removed", () => {
  it("an owner above the allowance keeps every Organization (listed, usable) but cannot create another", async () => {
    signIn("over");
    expect((await listAccessibleTenants()).map((o) => [o.slug, o.role])).toEqual([
      ["over-a", "OWNER"],
      ["over-b", "OWNER"],
      ["over-c", "OWNER"],
    ]);
    for (const id of ["over-a", "over-b", "over-c"]) {
      const res = await playersRoute.GET(new Request("http://itest.local/"), { params: Promise.resolve({ organizationSlug: id, groupSlug: `${id}-g` }) });
      expect(res.status, id).toBe(200);
    }
    const r = await post("over", "Fourth");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ owned: 3, allowed: 1 });
    expect(await ownedCount("over")).toBe(3);
  });

  it("when the qualifying Pro ends, both Organizations stay (plans unchanged otherwise); creating a third is refused", async () => {
    const second = await ws("paid", "Paid Second");
    // Stripe cancellation as the sync would project it: the subscription row ends, the paid Organization becomes FREE.
    await prisma.billingSubscription.update({ where: { stripeSubscriptionId: "sub_paid" }, data: { status: "canceled", endedAt: new Date() } });
    await prisma.organization.update({ where: { id: "paid" }, data: { plan: "FREE" } });
    expect(await ownershipAllowance("u-paid")).toEqual({ owned: 2, allowed: 1, canCreate: false, qualifiedBy: null });
    signIn("paid");
    expect((await listAccessibleTenants()).map((o) => o.slug).sort()).toEqual(["paid", second.organization.slug].sort());
    expect(await prisma.group.count({ where: { organizationId: { in: ["paid", second.organization.id] }, isActive: true } })).toBe(2);
    expect((await post("paid", "Paid Third")).status).toBe(409);
    // The invited ADMIN of "paid" keeps their membership.
    expect(await prisma.organizationMembership.count({ where: { userId: "u-invited", organizationId: "paid" } })).toBe(1);
  });
});

describe("Phase 1 — tenant isolation", () => {
  it("the allowance counts only the User's OWN owner memberships; other tenants' Organizations never count or leak", async () => {
    // u-stranger owns nothing — every other User's Organizations are irrelevant.
    expect(await ownershipAllowance("u-stranger")).toEqual({ owned: 0, allowed: 1, canCreate: true, qualifiedBy: null });
    // ADMIN of paid-Pro / COMP Organizations does not qualify anyone for a second owned Organization.
    await ws("invited", "Invited Own Club");
    expect(await ownershipAllowance("u-invited")).toMatchObject({ owned: 1, allowed: 1, qualifiedBy: null });
    const r = await post("invited", "Invited Second");
    expect(JSON.stringify(r.body)).not.toMatch(/Org paid|Org comp|Org legacy|sub_|cus_/);
  });

  it("the creator becomes OWNER of only the new Organization; a body userId is ignored", async () => {
    signIn("comp");
    const res = await organizationsRoute.POST(
      new Request("http://itest.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationName: "Comp Second", groupName: "G", sportKey: "soccer", timezone: "UTC", userId: "u-free" }) })
    );
    expect(res.status).toBe(201);
    const org = await prisma.organization.findFirstOrThrow({ where: { name: "Comp Second" }, select: { memberships: { select: { userId: true, role: true } } } });
    expect(org.memberships).toEqual([{ userId: "u-comp", role: "OWNER" }]);
    expect(await ownedCount("free")).toBe(1);
  });
});

describe("Phase 1 — UI explains the allowance", () => {
  it("/admin: count, no Create action and the reason when unavailable", async () => {
    signIn("over");
    const html = await render(AdminEntryPage);
    expect(html).toContain("Organizations owned: 3 of 1");
    expect(html).not.toContain('href="/onboarding"');
    expect(html).toContain("A second organization is available when an organization you own is on paid Pro, complimentary Pro or Early Access.");
  });
  it("/admin: an eligible owner sees 1 of 2, the Create action and the separate-billing note", async () => {
    await prisma.organizationMembership.create({ data: { userId: "u-comp", organizationId: "legacy", role: "MEMBER" } }); // 2 orgs → the list renders (no redirect)
    signIn("comp");
    const html = await render(AdminEntryPage);
    expect(html).toContain("Organizations owned: 1 of 2");
    expect(html).toContain('href="/onboarding"');
    expect(html).toContain(SECOND_ORGANIZATION_NOTE.replace("doesn't", "doesn&#x27;t"));
  });
  it("/onboarding: the form is replaced by the reason at the limit; shown with the note when eligible; plain for a first Organization", async () => {
    signIn("free");
    let html = await render(OnboardingPage);
    expect(html).toContain("Organizations owned: 1 of 1");
    expect(html).toContain("You can&#x27;t create another organization right now.");
    expect(html).not.toContain("<form");
    signIn("legacy");
    html = await render(OnboardingPage);
    expect(html).toContain("Organizations owned: 1 of 2");
    expect(html).toContain("<form");
    signIn("stranger");
    html = await render(OnboardingPage);
    expect(html).not.toContain("Organizations owned");
    expect(html).toContain("<form");
  });
});

describe("network safety", () => {
  it("no network call happened", () => {
    expect(otherNetwork).toBe(0);
  });
});
