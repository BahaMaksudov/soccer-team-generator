/**
 * Phase 4B step 4 — Game Day Update settings, REAL DATABASE (guarded local test
 * DB only). Settings only: nothing is sent, no weather call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as route from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/game-day-update/route";
import GroupSettingsPage from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/settings/page";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { createGroupInOrganization } from "@/lib/workspaces";
import { GAME_DAY_UPDATE_DEFAULTS, GAME_DAY_UPDATE_KEY } from "@/lib/gameDayUpdateSettings";

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
let network = 0;
const originalFetch = global.fetch;
const json = (method: string, body?: unknown) => new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = (who: string) => void (session = { user: { id: `u-${who}`, email: `${who}@example.test` } });
const p = (org: string, group = `${org}-g`) => ({ params: Promise.resolve({ organizationSlug: org, groupSlug: group }) });
const get = (org: string, group?: string) => call(route.GET(json("GET"), p(org, group)));
const put = (org: string, body: unknown, group?: string) => call(route.PUT(json("PUT", body), p(org, group)));
const ON = { enabled: true, hoursBefore: 6, includeWeather: false, units: "metric" };
const stored = async (group: string) => (await prisma.groupSetting.findUnique({ where: { groupId_key: { groupId: group, key: GAME_DAY_UPDATE_KEY } } }))?.value ?? null;

const PLANS = {
  free: { plan: "FREE", trialEndsAt: new Date("2026-01-01T00:00:00Z") },
  trial: { plan: "FREE", trialEndsAt: new Date("2099-01-01T00:00:00Z") },
  pro: { plan: "PRO", trialEndsAt: null },
  comp: { plan: "COMP", trialEndsAt: null },
  legacy: { plan: "LEGACY", trialEndsAt: null },
  other: { plan: "LEGACY", trialEndsAt: null },
} as const;

async function seed() {
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User","AppSetting" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const [org, plan] of Object.entries(PLANS)) {
    await prisma.organization.create({ data: { id: org, name: `Org ${org}`, slug: org, ...plan } });
    await prisma.group.create({ data: { id: `${org}-g`, organizationId: org, name: `${org} group`, slug: `${org}-g`, sportKey: "soccer", timezone: "America/New_York" } });
    if (org !== "other") {
      await prisma.organizationMembership.createMany({
        data: [
          { userId: "u-owner", organizationId: org, role: "OWNER" },
          { userId: "u-admin", organizationId: org, role: "ADMIN" },
          { userId: "u-member", organizationId: org, role: "MEMBER" },
        ],
      });
    }
  }
  await prisma.organizationMembership.create({ data: { userId: "u-other", organizationId: "other", role: "OWNER" } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    network++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
  vi.stubEnv("BILLING_ENABLED", "");
});
beforeEach(async () => {
  await seed();
  signIn("owner");
});
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("Phase 4B — Game Day Update settings: defaults and validation", () => {
  it("existing groups (no row) read the defaults: OFF, 4 h, weather on, imperial; nothing is written by reading", async () => {
    expect(await get("legacy")).toMatchObject({ status: 200, body: { settings: GAME_DAY_UPDATE_DEFAULTS, telegramAvailable: true, planMessage: null } });
    expect(await stored("legacy-g")).toBeNull();
  });

  it("newly created groups are OFF as well", async () => {
    const ctx = await requireOrganizationContextForSlug({ organizationSlug: "legacy" });
    const created = await createGroupInOrganization(ctx, { groupName: "Fresh", sportKey: "soccer", timezone: "UTC" });
    expect((await get("legacy", created.group.slug)).body.settings).toEqual(GAME_DAY_UPDATE_DEFAULTS);
  });

  it("valid writes are stored as one JSON row; enable / disable / weather / units round-trip", async () => {
    expect(await put("legacy", ON)).toMatchObject({ status: 200, body: { ok: true, settings: ON } });
    expect(JSON.parse((await stored("legacy-g"))!)).toEqual(ON);
    expect((await get("legacy")).body.settings).toEqual(ON);
    const off = { ...ON, enabled: false, includeWeather: true, units: "imperial" };
    expect((await put("legacy", off)).status).toBe(200);
    expect((await get("legacy")).body.settings).toEqual(off); // turning it off keeps the other preferences
    expect(await prisma.groupSetting.count({ where: { groupId: "legacy-g", key: GAME_DAY_UPDATE_KEY } })).toBe(1);
  });

  it("invalid offsets / units / shapes are rejected (400) and change nothing", async () => {
    await put("legacy", ON);
    for (const bad of [{ ...ON, hoursBefore: 3 }, { ...ON, hoursBefore: 24 }, { ...ON, hoursBefore: "4" }, { ...ON, units: "kelvin" }, { ...ON, enabled: "yes" }, { enabled: true }, null]) {
      expect((await put("legacy", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(JSON.parse((await stored("legacy-g"))!)).toEqual(ON);
  });

  it("other GroupSetting values are preserved; a malformed stored row reads as defaults", async () => {
    await prisma.groupSetting.createMany({ data: [{ groupId: "legacy-g", key: "teamName", value: "Eagles" }, { groupId: "legacy-g", key: "balanceWeights", value: "{\"staminaCoef\":1}" }] });
    await put("legacy", ON);
    await put("legacy", { ...ON, enabled: false });
    expect(await prisma.groupSetting.findMany({ where: { groupId: "legacy-g", key: { not: GAME_DAY_UPDATE_KEY } }, select: { key: true, value: true }, orderBy: { key: "asc" } })).toEqual([
      { key: "balanceWeights", value: "{\"staminaCoef\":1}" },
      { key: "teamName", value: "Eagles" },
    ]);
    await prisma.groupSetting.update({ where: { groupId_key: { groupId: "legacy-g", key: GAME_DAY_UPDATE_KEY } }, data: { value: "{oops" } });
    expect((await get("legacy")).body.settings).toEqual(GAME_DAY_UPDATE_DEFAULTS);
  });
});

describe("Phase 4B — permissions, plans and tenant isolation", () => {
  it("OWNER and ADMIN may read and change; MEMBER gets the generic 404 and changes nothing", async () => {
    signIn("admin");
    expect((await put("legacy", ON)).status).toBe(200);
    signIn("member");
    expect((await get("legacy")).status).toBe(404);
    expect((await put("legacy", { ...ON, enabled: false })).status).toBe(404);
    expect(JSON.parse((await stored("legacy-g"))!)).toEqual(ON);
  });

  it("Free: turning it on is refused on the server (402 PLAN_LIMIT, the existing explanation); turning it off / preferences while off are allowed", async () => {
    const view = await get("free");
    expect(view.body).toMatchObject({ telegramAvailable: false });
    expect(String(view.body.planMessage)).toContain("Telegram integration is part of Pro");
    expect(await put("free", ON)).toMatchObject({ status: 402, body: { code: "PLAN_LIMIT", metric: "telegram" } });
    expect(await stored("free-g")).toBeNull();
    expect((await put("free", { ...ON, enabled: false })).status).toBe(200);
  });

  it("Trial, Pro, Complimentary and Legacy organizations can turn it on", async () => {
    for (const org of ["trial", "pro", "comp", "legacy"]) {
      expect((await get(org)).body.telegramAvailable, org).toBe(true);
      expect((await put(org, ON)).status, org).toBe(200);
    }
  });

  it("another organization's owner gets 404 (via either group); body tenant ids are ignored", async () => {
    signIn("other");
    expect((await get("legacy")).status).toBe(404);
    expect((await put("legacy", ON)).status).toBe(404);
    expect((await put("other", { ...ON, groupId: "legacy-g", organizationId: "legacy" })).status).toBe(200);
    expect(await stored("legacy-g")).toBeNull();
    expect(JSON.parse((await stored("other-g"))!)).toEqual(ON);
  });

  it("the Group settings page (organizers) shows the Game Day Update card in the Telegram section", async () => {
    const html = renderToStaticMarkup(await GroupSettingsPage({ params: Promise.resolve({ organizationSlug: "legacy", groupSlug: "legacy-g" }) }));
    expect(html).toMatch(/id="telegram"[\s\S]*Game Day Update[\s\S]*Send a Game Day Update in Telegram/);
    expect(html).toContain('role="switch" aria-checked="false"');
    signIn("member");
    await expect(GroupSettingsPage({ params: Promise.resolve({ organizationSlug: "legacy", groupSlug: "legacy-g" }) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("no network call (nothing is sent, no weather lookup)", () => {
    expect(network).toBe(0);
  });
});
