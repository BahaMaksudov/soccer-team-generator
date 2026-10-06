/**
 * UI-5 — REAL-DATABASE tests for the Groups page read model and the Players
 * page's API boundary: Organization-scoped data only, Telegram status for
 * OWNER/ADMIN only, foreign tenants rejected. Guarded local TEST database.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireOrganizationContextForSlug, TenantContextError } from "@/lib/tenantContext";
import { loadOrganizationGroups } from "@/lib/organizationGroups";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import * as playerRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/route";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const signIn = async (email: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email } };
};
const ctx = async (email: string, organizationSlug = "org-a") => (await signIn(email), requireOrganizationContextForSlug({ organizationSlug }));
const req = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "Org A", slug: "org-a" }, { id: "org-b", name: "Org B", slug: "org-b" }] });
  await prisma.group.createMany({
    data: [
      { id: "g1", organizationId: "org-a", name: "Indoor", slug: "indoor", sportKey: "soccer", timezone: "UTC", visibility: "LINK" },
      { id: "g2", organizationId: "org-a", name: "Hoops", slug: "hoops", sportKey: "basketball", timezone: "UTC" }, // default visibility
      { id: "g3", organizationId: "org-a", name: "Archived", slug: "old", sportKey: "soccer", timezone: "UTC", isActive: false },
      { id: "gb", organizationId: "org-b", name: "Secret", slug: "secret", sportKey: "volleyball", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other", organizationId: "org-b", role: "OWNER" },
    ],
  });
  await prisma.player.createMany({
    data: [
      { id: "p1", groupId: "g1", firstName: "A", lastName: "One", position: "DEFENDER", rating: "GOOD", stamina: 3 },
      { id: "p2", groupId: "g1", firstName: "B", lastName: "Two", position: "FORWARD", rating: "GOOD", stamina: 3, isActive: false },
      { id: "p3", groupId: "g2", firstName: "C", lastName: "Three", position: "GUARD", rating: "GOOD", stamina: 3 },
      { id: "pb", groupId: "gb", firstName: "Z", lastName: "B", position: "SETTER", rating: "GOOD", stamina: 3 },
    ],
  });
  await prisma.match.createMany({
    data: [
      { id: "m1", groupId: "g1", date: new Date("2099-01-10T00:00:00Z"), startTime: "19:00" },
      { id: "m2", groupId: "g1", date: new Date("2099-02-10T00:00:00Z") },
      { id: "m-old", groupId: "g1", date: new Date("2020-01-01T00:00:00Z") },
    ],
  });
  await prisma.telegramChat.create({ data: { groupId: "g1", chatId: -1001n, title: "Chat" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
});
beforeEach(async () => {
  session = null;
  await seed();
});
afterAll(() => prisma.$disconnect());

describe("Groups page read model", () => {
  it("OWNER: the Organization's ACTIVE groups with real counts, next match and Telegram status", async () => {
    const { canManage, groups } = await loadOrganizationGroups(await ctx("owner@example.test"), new Date("2026-10-05T12:00:00Z"));
    expect(canManage).toBe(true);
    expect(groups.map((g) => [g.slug, g.sportLabel, g.visibilityLabel, g.activePlayers, g.upcomingMatches, g.telegramConnected])).toEqual([
      ["hoops", "Basketball", "Anyone with the link", 1, 0, false], // schema default visibility; same createdAt → by name
      ["indoor", "Soccer", "Anyone with the link", 1, 2, true],
    ]);
    expect(groups[1].nextMatch).toEqual({ date: "2099-01-10", startTime: "19:00", href: "/admin/o/org-a/g/indoor/matches/m1" });
    expect(groups[1].playersHref).toBe("/admin/o/org-a/g/indoor/players");
    expect(JSON.stringify(groups)).not.toMatch(/Secret|old|Archived|rating|stamina|-1001/);
  });
  it("MEMBER: same groups, no Telegram status", async () => {
    const { canManage, groups } = await loadOrganizationGroups(await ctx("member@example.test"));
    expect(canManage).toBe(false);
    expect(groups.map((g) => g.telegramConnected)).toEqual([null, null]);
  });
  it("another Organization: no access (generic tenant error → 404 page)", async () => {
    await expect(ctx("other@example.test", "org-a")).rejects.toBeInstanceOf(TenantContextError);
    await expect(ctx("owner@example.test", "org-b")).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("Players page APIs keep tenant + role enforcement", () => {
  const g = (organizationSlug: string, groupSlug: string) => ({ params: Promise.resolve({ organizationSlug, groupSlug }) });
  it("MEMBER may list but not add / edit / deactivate; a foreign Organization gets 404", async () => {
    await signIn("member@example.test");
    expect((await playersRoute.GET(req("GET"), g("org-a", "indoor"))).status).toBe(200);
    expect((await playersRoute.POST(req("POST", { firstName: "X", lastName: "Y", position: "DEFENDER", rating: "GOOD", stamina: 3 }), g("org-a", "indoor"))).status).toBe(404);
    expect((await playerRoute.PATCH(req("PATCH", { isActive: false }), { params: Promise.resolve({ organizationSlug: "org-a", groupSlug: "indoor", id: "p1" }) })).status).toBe(404);
    await signIn("other@example.test");
    expect((await playersRoute.GET(req("GET"), g("org-a", "indoor"))).status).toBe(404);
    await signIn("owner@example.test");
    expect((await playerRoute.PATCH(req("PATCH", { isActive: false }), { params: Promise.resolve({ organizationSlug: "org-a", groupSlug: "indoor", id: "pb" }) })).status).toBe(404); // another tenant's player
    expect((await playerRoute.PATCH(req("PATCH", { isActive: false }), { params: Promise.resolve({ organizationSlug: "org-a", groupSlug: "indoor", id: "p1" }) })).status).toBe(200);
    expect((await prisma.player.findUniqueOrThrow({ where: { id: "pb" } })).isActive).toBe(true);
  });
});
