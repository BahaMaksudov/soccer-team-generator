/**
 * UI-8 — group Settings is the one organizer location for group-level
 * configuration after the legacy Overview workspace was removed.
 *
 *  - The pages' guard (loadCanonicalAdminContext [+ isManager for Settings],
 *    pinned in src/lib/__tests__/groupSettingsUi.test.ts): Settings resolves for
 *    OWNER / ADMIN only; MEMBER, a foreign Organization's OWNER and an unknown
 *    Group get the generic 404. Overview / Players / Matches resolve for every
 *    member (MEMBER read-only); foreign tenants 404. (The integration config
 *    has no JSX transform, so the guard — not the JSX page — is exercised.)
 *  - Every API the Settings page uses (team name, balance weights,
 *    visibility, Telegram channels, Telegram voter links) keeps its existing
 *    authorization: OWNER/ADMIN 200; foreign tenant 404; MEMBER 404 for
 *    visibility / Telegram reads and for every write. (Team name and balance
 *    weights reads were already open to any member — unchanged here.)
 *
 * Guarded local TEST database only; nothing is sent (global fetch is a guard).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { loadCanonicalAdminContext } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/data";
import { isManager } from "@/lib/tenantRoute";
import * as teamNameRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/team-name/route";
import * as weightsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/balance-weights/route";
import * as visibilityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/visibility/route";
import * as channelsRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/channels/telegram/route";
import * as votersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/telegram/users/route";

const A = { organizationSlug: "org-a", groupSlug: "group-a" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const p = (x: typeof A = A) => ({ params: Promise.resolve(x) });
const req = () => new Request("http://itest.local/");
const signIn = async (who: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};
const originalFetch = global.fetch;
let networkCalls = 0;

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MessageDelivery","MatchRecap","MatchMvpVote","MatchMvp","MatchResult","AttendanceResponse","TeamGeneration","Match","TelegramChatPlayer","TelegramChatBindCode","TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  await prisma.organization.createMany({ data: [{ id: "org-a", name: "A", slug: "org-a" }, { id: "org-b", name: "B", slug: "org-b" }] });
  await prisma.group.createMany({
    data: [
      { id: "ga", organizationId: "org-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "UTC" },
      { id: "gb", organizationId: "org-b", name: "Group B", slug: "group-b", sportKey: "soccer", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-admin", organizationId: "org-a", role: "ADMIN" },
      { userId: "u-member", organizationId: "org-a", role: "MEMBER" },
      { userId: "u-other", organizationId: "org-b", role: "OWNER" },
    ],
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    networkCalls++;
    throw new Error("network disabled in tests");
  }) as typeof fetch;
});
beforeEach(async () => {
  session = null;
  networkCalls = 0;
  await seed();
});
afterAll(async () => {
  global.fetch = originalFetch;
  await prisma.$disconnect();
});

/** Exactly the pages' guards: group pages 404 on a null context; Settings also on !isManager. */
const groupPage = async (x: typeof A = A) => (await loadCanonicalAdminContext(x)) !== null;
const settingsPage = async (x: typeof A = A) => {
  const context = await loadCanonicalAdminContext(x);
  return context !== null && isManager(context);
};

describe("Group settings page — page-level guard", () => {
  it.each(["owner", "admin"])("%s: allowed", async (who) => {
    await signIn(who);
    expect(await settingsPage()).toBe(true);
  });
  it("MEMBER: generic 404", async () => {
    await signIn("member");
    expect(await settingsPage()).toBe(false);
  });
  it("another Organization's OWNER / unknown Group / foreign Group by URL: generic 404", async () => {
    await signIn("other");
    expect(await settingsPage()).toBe(false);
    await signIn("owner");
    expect(await settingsPage({ ...A, groupSlug: "nope" })).toBe(false);
    expect(await settingsPage({ organizationSlug: "org-b", groupSlug: "group-b" })).toBe(false);
    expect(await settingsPage({ organizationSlug: "org-a", groupSlug: "group-b" })).toBe(false);
  });
});

describe("Overview / Players / Matches stay reachable (MEMBER read-only); foreign tenants 404", () => {
  it.each(["owner", "admin", "member"])("%s: allowed", async (who) => {
    await signIn(who);
    expect(await groupPage()).toBe(true);
  });
  it("another Organization's OWNER: 404", async () => {
    await signIn("other");
    expect(await groupPage()).toBe(false);
  });
});

describe("settings APIs keep their authorization", () => {
  const memberReadable = {
    teamName: () => teamNameRoute.GET(req(), p()),
    balanceWeights: () => weightsRoute.GET(req(), p()),
  };
  const managerOnly = {
    visibility: () => visibilityRoute.GET(req(), p()),
    telegramChannels: () => channelsRoute.GET(req(), p()),
    telegramVoters: () => votersRoute.GET(req(), p()),
  };
  const reads = { ...memberReadable, ...managerOnly };
  it.each(["owner", "admin"])("%s: 200 for every settings read", async (who) => {
    await signIn(who);
    for (const [name, call] of Object.entries(reads)) expect((await call()).status, name).toBe(200);
  });
  it("another Organization's OWNER: 404 for every settings read", async () => {
    await signIn("other");
    for (const [name, call] of Object.entries(reads)) expect((await call()).status, name).toBe(404);
  });
  it("MEMBER: 404 for visibility / Telegram reads (unchanged: team name + balance weights reads stay open)", async () => {
    await signIn("member");
    for (const [name, call] of Object.entries(managerOnly)) expect((await call()).status, name).toBe(404);
    for (const [name, call] of Object.entries(memberReadable)) expect((await call()).status, name).toBe(200);
  });
  it("MEMBER cannot write settings (404, nothing changed)", async () => {
    await signIn("member");
    const put = (body: unknown) => new Request("http://itest.local/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await teamNameRoute.PUT(put({ teamName: "Hacked" }), p())).status).toBe(404);
    expect((await weightsRoute.PUT(put({ weights: { staminaCoef: 9, positionWeights: {} } }), p())).status).toBe(404);
    expect((await visibilityRoute.PUT(put({ visibility: "PUBLIC" }), p())).status).toBe(404);
    expect(await prisma.groupSetting.count({ where: { groupId: "ga" } })).toBe(0);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "ga" } })).visibility).not.toBe("PUBLIC");
  });
  it("nothing was sent", () => {
    expect(networkCalls).toBe(0);
  });
});
