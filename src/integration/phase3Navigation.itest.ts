/**
 * Phase 3 — Login → My Organizations → My Groups → Group dashboard, REAL
 * DATABASE (guarded local test DB only). Pages are rendered server-side as the
 * signed-in User; nothing is written by navigation. No network.
 *
 * Users: "new" (no organizations), "solo" (owns one org with one group),
 * "multi" (owns "alpha", ADMIN of "beta", MEMBER of "gamma"), "admin" (ADMIN of alpha),
 * "member" (MEMBER of alpha), "other" (owns "other").
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import AdminEntryPage from "@/app/admin/page";
import GroupsPage from "@/app/admin/o/[organizationSlug]/groups/page";
import * as groupsRoute from "@/app/api/admin/o/[organizationSlug]/groups/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as matchesRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/route";
import * as billingRoute from "@/app/api/admin/o/[organizationSlug]/billing/route";
import { loadShellDataFor, type ShellDataSource } from "@/lib/appShellData";
import { buildShellNav } from "@/lib/appShell";
import { DEFAULT_AFTER_LOGIN } from "@/lib/safeRedirect";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
let otherNetwork = 0;
const originalFetch = global.fetch;

const signIn = (who: string | null) => void (session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null);
const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(await page);
const myOrgs = () => render(AdminEntryPage());
const myGroups = (org: string) => render(GroupsPage({ params: Promise.resolve({ organizationSlug: org }) }));
const json = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const status = async (res: Promise<Response> | Response) => (await res).status;
const g = (org: string, group: string) => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const shellFor = async (who: string) => (await loadShellDataFor({ email: `${who}@example.test`, id: `u-${who}` }, prisma as unknown as ShellDataSource))!;
/** NEXT_REDIRECT digest of a server redirect(), or null when the page rendered. */
async function redirectOf(page: () => Promise<ReactElement>): Promise<string | null> {
  try {
    await page();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? digest;
    throw e;
  }
}

async function org(id: string, plan: "FREE" | "LEGACY" | "COMP", groups: Array<[string, string]>) {
  await prisma.organization.create({ data: { id, name: `Org ${id}`, slug: id, plan } });
  for (const [slug, sportKey] of groups) {
    await prisma.group.create({ data: { id: `${id}-${slug}`, organizationId: id, name: `${id} ${slug}`, slug, sportKey, timezone: "UTC" } });
  }
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MatchScheduleSkip","StripeEvent","BillingCheckoutSession","BillingSubscription","EntitlementEvent","AiUsage","MatchSchedule","Match","CommunityPlayer","Community","Player","GroupSetting","Group","OrganizationMembership","OrganizationInvitation","EmailVerificationToken","Organization","User" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: ["new", "solo", "multi", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED, trialUsedAt: VERIFIED })),
  });
  await org("solo", "FREE", [["only", "soccer"]]);
  await org("alpha", "LEGACY", [["mon", "soccer"], ["tue", "basketball"]]);
  await org("beta", "FREE", [["wed", "soccer"]]);
  await org("gamma", "FREE", []);
  await org("other", "FREE", [["sun", "soccer"]]);
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-solo", organizationId: "solo", role: "OWNER" },
      { userId: "u-multi", organizationId: "alpha", role: "OWNER" },
      { userId: "u-multi", organizationId: "beta", role: "ADMIN" },
      { userId: "u-multi", organizationId: "gamma", role: "MEMBER" },
      { userId: "u-admin", organizationId: "alpha", role: "ADMIN" },
      { userId: "u-member", organizationId: "alpha", role: "MEMBER" },
      { userId: "u-other", organizationId: "other", role: "OWNER" },
    ],
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
  vi.stubEnv("BILLING_ENABLED", "");
});
beforeEach(async () => {
  session = null;
  await seed();
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("Phase 3 — My Organizations (/admin, where sign-in lands)", () => {
  it("sign-in lands on /admin", () => {
    expect(DEFAULT_AFTER_LOGIN).toBe("/admin");
  });

  it("a new User without organizations: welcome + Create your first organization (no redirect)", async () => {
    signIn("new");
    expect(await redirectOf(() => AdminEntryPage())).toBeNull();
    const html = await myOrgs();
    expect(html).toContain("My Organizations");
    expect(html).toContain("Welcome to Team Balance Pro!");
    expect(html).toContain('href="/onboarding"');
    expect(html).toContain("Create your first organization");
  });

  it("one organization with one group: still the selection page (never auto-selected); the card opens My Groups", async () => {
    signIn("solo");
    expect(await redirectOf(() => AdminEntryPage())).toBeNull();
    const html = await myOrgs();
    expect(html).toContain("Org solo");
    expect(html).toContain('href="/admin/o/solo/groups"');
    expect(html).not.toContain('href="/admin/o/solo/g/');
    // Phase 1: a Free owner of one organization cannot create another.
    expect(html).toContain("Organizations owned: 1 of 1");
    expect(html).not.toContain('href="/onboarding"');
  });

  it("several organizations, owned and invited, each with its real role; invited ones don't use the ownership allowance", async () => {
    signIn("multi");
    const html = await myOrgs();
    for (const [o, role] of [["alpha", "Owner"], ["beta", "Admin"], ["gamma", "Member"]]) {
      expect(html, o).toContain(`href="/admin/o/${o}/groups"`);
      expect(html, o).toMatch(new RegExp(`Org ${o}[\\s\\S]*?${role}`));
    }
    expect(html).not.toContain("Org other");
    // Owns one LEGACY org (ADMIN/MEMBER elsewhere don't count) → 1 of 2, may create a second.
    expect(html).toContain("Organizations owned: 1 of 2");
    expect(html).toContain('href="/onboarding"');
  });

  it("invited ADMIN / MEMBER see the organization they belong to", async () => {
    for (const who of ["admin", "member"]) {
      signIn(who);
      const html = await myOrgs();
      expect(html, who).toContain('href="/admin/o/alpha/groups"');
      expect(html, who).toContain("Organizations owned: 0 of 1");
    }
  });
});

describe("Phase 3 — My Groups (/admin/o/[org]/groups)", () => {
  it("lists the organization's groups with their sport; a card opens the group dashboard", async () => {
    signIn("multi");
    const html = await myGroups("alpha");
    expect(html).toContain("My Groups");
    expect(html).toMatch(/alpha mon[\s\S]*?Soccer/);
    expect(html).toMatch(/alpha tue[\s\S]*?Basketball/);
    expect(html).toContain('href="/admin/o/alpha/g/mon"');
    expect(html).toContain('href="/admin/o/alpha/groups/new"'); // OWNER may create
  });

  it("no groups: an organizer is offered Create your first group; a MEMBER is not", async () => {
    await prisma.organizationMembership.update({ where: { userId_organizationId: { userId: "u-multi", organizationId: "gamma" } }, data: { role: "ADMIN" } });
    signIn("multi");
    let html = await myGroups("gamma");
    expect(html).toContain("Create your first group");
    expect(html).toContain('href="/admin/o/gamma/groups/new"');
    signIn("member");
    await prisma.organizationMembership.create({ data: { userId: "u-member", organizationId: "gamma", role: "MEMBER" } });
    html = await myGroups("gamma");
    expect(html).toContain("No groups yet");
    expect(html).not.toContain("/groups/new");
  });

  it("creating a group with a sport: appears on My Groups; Free plan group limit still applies; no duplicate on resubmit", async () => {
    signIn("multi");
    const body = { groupName: "Thursday Hoops", sportKey: "basketball", timezone: "UTC" };
    expect(await status(groupsRoute.POST(json("POST", body), { params: Promise.resolve({ organizationSlug: "alpha" }) }))).toBe(201);
    expect(await status(groupsRoute.POST(json("POST", body), { params: Promise.resolve({ organizationSlug: "alpha" }) }))).toBe(200); // replay
    expect(await prisma.group.count({ where: { organizationId: "alpha", name: "Thursday Hoops", sportKey: "basketball" } })).toBe(1);
    expect(await myGroups("alpha")).toMatch(/Thursday Hoops[\s\S]*?Basketball/);
    // beta is Free (1 group, already used): ADMIN may try, the plan refuses.
    const refused = await groupsRoute.POST(json("POST", { groupName: "Second", sportKey: "soccer", timezone: "UTC" }), { params: Promise.resolve({ organizationSlug: "beta" }) });
    expect(refused.status).toBe(402);
    expect(await prisma.group.count({ where: { organizationId: "beta" } })).toBe(1);
  });

  it("another organization's groups page is the generic 404 (never leaked)", async () => {
    signIn("multi");
    await expect(myGroups("other")).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") });
  });
});

describe("Phase 3 — sidebar context from real memberships, direct URLs, and regressions", () => {
  it("group switching stays within the selected organization; never another organization's groups", async () => {
    const d = await shellFor("multi");
    const nav = (p: string) => buildShellNav({ data: d, pathname: p });
    // State C in alpha: All Groups returns to alpha; no link into beta/gamma.
    const c = nav("/admin/o/alpha/g/tue");
    expect(c.find((i) => i.key === "all-groups")?.href).toBe("/admin/o/alpha/groups");
    expect(c.every((i) => !/\/admin\/o\/(beta|gamma)/.test(i.href))).toBe(true);
    // State B in beta (ADMIN): Billing & Plan, no Members (OWNER only).
    expect(nav("/admin/o/beta").map((i) => i.key)).toEqual(["groups", "organization", "billing", "organizations", "account"]);
    // A slug the User can't access is no context at all (State A).
    expect(nav("/admin/o/other/g/sun").map((i) => i.key)).toEqual(["organizations", "account"]);
  });

  it("direct URLs / refresh: authorized pages open directly; foreign ones stay blocked server-side", async () => {
    signIn("multi");
    expect(await status(playersRoute.GET(json("GET"), g("alpha", "mon")))).toBe(200);
    expect(await status(matchesRoute.GET(json("GET"), g("beta", "wed")))).toBe(200);
    expect(await status(playersRoute.GET(json("GET"), g("other", "sun")))).toBe(404);
    signIn("member");
    expect(await status(billingRoute.GET(json("GET"), { params: Promise.resolve({ organizationSlug: "alpha" }) }))).toBe(404); // MEMBER: no billing
    signIn("multi");
    expect(await status(billingRoute.GET(json("GET"), { params: Promise.resolve({ organizationSlug: "alpha" }) }))).toBe(200);
  });

  it("navigation pages write nothing", async () => {
    const before = await Promise.all([prisma.organization.count(), prisma.group.count(), prisma.organizationMembership.count()]);
    for (const who of ["new", "solo", "multi"]) {
      signIn(who);
      await myOrgs();
    }
    signIn("multi");
    await myGroups("alpha");
    await shellFor("multi");
    expect(await Promise.all([prisma.organization.count(), prisma.group.count(), prisma.organizationMembership.count()])).toEqual(before);
    expect(otherNetwork).toBe(0);
  });
});
