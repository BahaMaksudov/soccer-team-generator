/**
 * M6-A — REAL-DATABASE tests for Group visibility, share links, the
 * player-facing allow-list and the Player.userId foundation.
 *
 * Guarded local TEST database only. Real route handlers, loaders,
 * services and Prisma; only NextAuth's session lookup is mocked.
 * global fetch is a counting guard — no Telegram/Resend/network call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcrypt";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/secureToken";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { loadPublicGroupHomeData } from "@/app/g/[organizationSlug]/[groupSlug]/data";
import { loadPublicGroupPrintData } from "@/app/g/[organizationSlug]/[groupSlug]/print/[generationId]/data";
import * as publicPlayersRoute from "@/app/api/public/[organizationSlug]/[groupSlug]/players/route";
import * as shareViewRoute from "@/app/api/share/view/route";
import * as visibilityRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/settings/visibility/route";
import * as shareLinkRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/share-link/route";

const ORG_A = "org-a";
const ORG_B = "org-b";
const GA = { organizationSlug: ORG_A, groupSlug: "group-a" };
const GB = { organizationSlug: ORG_B, groupSlug: "group-b" };

let networkCalls = 0;
const originalFetch = global.fetch;

const json = (method: string, body?: unknown) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (x: { organizationSlug: string; groupSlug: string }) => ({ params: Promise.resolve(x) });

async function signInAs(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  session = { user: { id: u.id, email: u.email } };
}

async function setVisibility(groupId: string, visibility: "PUBLIC" | "LINK" | "PRIVATE") {
  await prisma.group.update({ where: { id: groupId }, data: { visibility } });
}

/** Creates a share link through the real organizer route; returns the raw token from sharePath. */
async function createLinkAs(email: string, g: typeof GA) {
  await signInAs(email);
  const res = await shareLinkRoute.POST(json("POST", {}), p(g));
  expect(res.status).toBe(201);
  const { sharePath } = await res.json();
  expect(sharePath).toMatch(/^\/share#[A-Za-z0-9_-]{43}$/);
  session = null;
  return sharePath.split("#")[1] as string;
}

const viewShare = (token: unknown) => shareViewRoute.POST(json("POST", { token }));

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","GroupShareLink","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  const verified = new Date("2026-10-01T00:00:00Z");
  const mk = (email: string, emailVerifiedAt: Date | null = verified) =>
    prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash: bcrypt.hashSync("x-password-1", 4), emailVerifiedAt } });
  const [ownerA, adminA, memberA, ownerB, unverifiedA] = await Promise.all([
    mk("owner-a@example.test"),
    mk("admin-a@example.test"),
    mk("member-a@example.test"),
    mk("owner-b@example.test"),
    mk("unverified-a@example.test", null),
  ]);
  for (const [orgId, slug] of [["org-a-id", ORG_A], ["org-b-id", ORG_B]]) {
    await prisma.organization.create({ data: { id: orgId, name: slug.toUpperCase(), slug } });
  }
  for (const [userId, orgId, role] of [
    [ownerA.id, "org-a-id", "OWNER"],
    [adminA.id, "org-a-id", "ADMIN"],
    [memberA.id, "org-a-id", "MEMBER"],
    [unverifiedA.id, "org-a-id", "OWNER"],
    [ownerB.id, "org-b-id", "OWNER"],
  ] as const) {
    await prisma.organizationMembership.create({ data: { userId, organizationId: orgId, role } });
  }
  for (const [id, orgId, slug] of [["ga", "org-a-id", "group-a"], ["gb", "org-b-id", "group-b"]]) {
    await prisma.group.create({ data: { id, organizationId: orgId, name: slug, slug, timezone: "America/New_York", visibility: "PUBLIC" } });
    await prisma.groupSetting.create({ data: { groupId: id, key: "teamName", value: `Team ${slug}` } });
    await prisma.player.create({ data: { id: `${id}-p1`, groupId: id, firstName: `First-${id}`, lastName: "Last", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5, telegramUserId: id === "ga" ? 555n : 556n, telegramUsername: `tg_${id}` } });
    await prisma.teamGeneration.create({
      data: {
        id: `gen-${id}`,
        groupId: id,
        date: new Date("2026-10-05T00:00:00Z"),
        // Real published snapshots carry organizer data — it must never reach player-facing views.
        teamsJson: JSON.stringify([
          { teamNumber: 1, players: [{ id: `${id}-p1`, firstName: `First-${id}`, lastName: "Last", position: "GOALKEEPER", rating: "EXCELLENT", stamina: 5, telegramUserId: "555", email: "leak@example.test" }] },
        ]),
      },
    });
  }
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const expected = new URL(guarded).pathname.replace(/^\//, "");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (db !== expected || !/test/i.test(db)) throw new Error(`Connected to '${db}', expected test database '${expected}' — aborting.`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
});

describe("M6-A visibility on slug URLs (/g pages + public APIs)", () => {
  it("PUBLIC: anonymous viewers see the Group page, print view and roster", async () => {
    expect(await loadPublicGroupHomeData(GA)).not.toBeNull();
    expect(await loadPublicGroupPrintData({ ...GA, generationId: "gen-ga" })).not.toBeNull();
    expect((await publicPlayersRoute.GET(new Request("http://itest.local/"), p(GA))).status).toBe(200);
  });

  it("LINK and PRIVATE: anonymous slug access fails closed exactly like a missing Group", async () => {
    for (const v of ["LINK", "PRIVATE"] as const) {
      await setVisibility("ga", v);
      expect(await loadPublicGroupHomeData(GA), v).toBeNull();
      expect(await loadPublicGroupPrintData({ ...GA, generationId: "gen-ga" }), v).toBeNull();
      expect((await publicPlayersRoute.GET(new Request("http://itest.local/"), p(GA))).status, v).toBe(404);
    }
    expect(await loadPublicGroupHomeData({ ...GA, groupSlug: "nope" })).toBeNull();
  });

  it("PRIVATE: the Group's verified organizers can view; other tenants and unverified accounts cannot", async () => {
    await setVisibility("ga", "PRIVATE");
    for (const email of ["owner-a@example.test", "admin-a@example.test", "member-a@example.test"]) {
      await signInAs(email);
      expect(await loadPublicGroupHomeData(GA), email).not.toBeNull();
    }
    await signInAs("owner-b@example.test");
    expect(await loadPublicGroupHomeData(GA)).toBeNull();
    expect((await publicPlayersRoute.GET(new Request("http://itest.local/"), p(GA))).status).toBe(404);
    await signInAs("unverified-a@example.test");
    expect(await loadPublicGroupHomeData(GA)).toBeNull();
  });

  it("cross-tenant: making Group B private never affects Group A and vice versa", async () => {
    await setVisibility("gb", "PRIVATE");
    expect(await loadPublicGroupHomeData(GA)).not.toBeNull();
    expect(await loadPublicGroupHomeData(GB)).toBeNull();
    await signInAs("owner-a@example.test");
    expect(await loadPublicGroupHomeData(GB)).toBeNull(); // an organizer of A is nobody in B
  });
});

describe("M6-A share links", () => {
  it("LINK: no token → 404; valid token → allow-listed teams; token stored only as a hash", async () => {
    await setVisibility("ga", "LINK");
    const token = await createLinkAs("owner-a@example.test", GA);

    expect((await viewShare(undefined)).status).toBe(404);
    expect((await viewShare("x".repeat(43))).status).toBe(404);

    const res = await viewShare(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.json();
    expect(body).toEqual({
      groupName: "group-a",
      sportKey: "soccer", // M7: role labels only
      teamName: "Team group-a",
      generations: [{ date: "2026-10-05", teams: [{ teamNumber: 1, players: [{ firstName: "First-ga", lastName: "Last", position: "GOALKEEPER" }] }] }],
    });

    const rows = await prisma.groupShareLink.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId: "ga", tokenHash: hashToken(token), revokedAt: null });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "GroupShareLink"`))).not.toContain(token);
  });

  it("player-facing payloads never contain rating, stamina, Telegram identity, email or ids", async () => {
    await setVisibility("ga", "LINK");
    const token = await createLinkAs("owner-a@example.test", GA);
    const shareText = await (await viewShare(token)).text();
    await setVisibility("ga", "PUBLIC");
    const pageData = JSON.stringify(await loadPublicGroupHomeData(GA));
    const printData = JSON.stringify(await loadPublicGroupPrintData({ ...GA, generationId: "gen-ga" }));
    const rosterText = await (await publicPlayersRoute.GET(new Request("http://itest.local/"), p(GA))).text();
    for (const [name, text] of [["share", shareText], ["page", pageData], ["print", printData]] as const) {
      for (const banned of ["rating", "EXCELLENT", "stamina", "telegram", "555", "leak@example.test", "email", "ga-p1", "passwordHash", "tokenHash"]) {
        expect(text, `${name}: ${banned}`).not.toContain(banned);
      }
    }
    for (const banned of ["rating", "stamina", "telegram", "555", "email"]) expect(rosterText, `roster: ${banned}`).not.toContain(banned);
  });

  it("a Group B token only ever shows Group B; tokens are bound to their Group", async () => {
    await setVisibility("ga", "LINK");
    await setVisibility("gb", "LINK");
    const tokenB = await createLinkAs("owner-b@example.test", GB);
    const view = await (await viewShare(tokenB)).json();
    expect(view.groupName).toBe("group-b");
    expect(JSON.stringify(view)).not.toContain("group-a");
    // Group A without its own link is still not viewable anonymously.
    expect(await loadPublicGroupHomeData(GA)).toBeNull();
  });

  it("an organizer of another Organization cannot create, rotate, revoke or read Group A's link settings", async () => {
    await signInAs("owner-b@example.test");
    expect((await shareLinkRoute.POST(json("POST", {}), p(GA))).status).toBe(404);
    expect((await shareLinkRoute.DELETE(json("DELETE"), p(GA))).status).toBe(404);
    expect((await visibilityRoute.GET(json("GET"), p(GA))).status).toBe(404);
    expect((await visibilityRoute.PUT(json("PUT", { visibility: "PRIVATE" }), p(GA))).status).toBe(404);
    expect(await prisma.groupShareLink.count()).toBe(0);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "ga" } })).visibility).toBe("PUBLIC");
  });

  it("revoked → 404; rotation invalidates the old token and the new one works", async () => {
    await setVisibility("ga", "LINK");
    const first = await createLinkAs("owner-a@example.test", GA);
    const second = await createLinkAs("admin-a@example.test", GA); // ADMIN may rotate
    expect((await viewShare(first)).status).toBe(404);
    expect((await viewShare(second)).status).toBe(200);
    expect(await prisma.groupShareLink.count({ where: { revokedAt: null } })).toBe(1);

    await signInAs("owner-a@example.test");
    const del = await shareLinkRoute.DELETE(json("DELETE"), p(GA));
    expect(await del.json()).toEqual({ ok: true, revoked: 1 });
    expect((await viewShare(second)).status).toBe(404);
  });

  it("concurrent rotations leave exactly one active link", async () => {
    await signInAs("owner-a@example.test");
    await Promise.all([1, 2, 3].map(() => shareLinkRoute.POST(json("POST", {}), p(GA))));
    expect(await prisma.groupShareLink.count({ where: { groupId: "ga", revokedAt: null } })).toBe(1);
  });

  it("PRIVATE disables every share link (without revoking); PUBLIC links keep working", async () => {
    await setVisibility("ga", "LINK");
    const token = await createLinkAs("owner-a@example.test", GA);
    await setVisibility("ga", "PRIVATE");
    expect((await viewShare(token)).status).toBe(404);
    await setVisibility("ga", "PUBLIC");
    expect((await viewShare(token)).status).toBe(200);
  });

  it("MEMBER cannot manage visibility or links (generic 404); the settings response carries no token material", async () => {
    await signInAs("member-a@example.test");
    expect((await shareLinkRoute.POST(json("POST", {}), p(GA))).status).toBe(404);
    expect((await visibilityRoute.PUT(json("PUT", { visibility: "PRIVATE" }), p(GA))).status).toBe(404);

    await signInAs("owner-a@example.test");
    await shareLinkRoute.POST(json("POST", {}), p(GA));
    const settings = await (await visibilityRoute.GET(json("GET"), p(GA))).text();
    expect(JSON.parse(settings)).toMatchObject({ visibility: "PUBLIC", activeLink: { createdAt: expect.any(String) } });
    expect(settings).not.toMatch(/token|hash|share#/i);
  });

  it("visibility PUT validates input and accepts only the three modes", async () => {
    await signInAs("owner-a@example.test");
    expect((await visibilityRoute.PUT(json("PUT", { visibility: "SECRET" }), p(GA))).status).toBe(400);
    const res = await visibilityRoute.PUT(json("PUT", { visibility: "LINK", groupId: "gb" }), p(GA));
    expect(res.status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "ga" } })).visibility).toBe("LINK");
    expect((await prisma.group.findUniqueOrThrow({ where: { id: "gb" } })).visibility).toBe("PUBLIC");
  });
});

describe("M6-A defaults and Player.userId foundation", () => {
  it("a newly created self-service Group defaults to LINK", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "owner-b@example.test" } });
    const ws = await createOrganizationWorkspace(u.id, { organizationName: "Fresh Org", groupName: "Fresh Group", sportKey: "soccer", timezone: "UTC" });
    expect((await prisma.group.findUniqueOrThrow({ where: { id: ws.group.id } })).visibility).toBe("LINK");
  });

  it("existing Players stay unclaimed; one User can claim at most one Player per Group, but Players in several Groups", async () => {
    expect(await prisma.player.count({ where: { NOT: { userId: null } } })).toBe(0);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "member-a@example.test" } });
    await prisma.player.update({ where: { id: "ga-p1" }, data: { userId: u.id } });
    await prisma.player.create({ data: { id: "ga-p2", groupId: "ga", firstName: "Dup", lastName: "X", position: "DEFENDER", rating: "GOOD" } });
    await expect(prisma.player.update({ where: { id: "ga-p2" }, data: { userId: u.id } })).rejects.toMatchObject({ code: "P2002" });
    await prisma.player.update({ where: { id: "gb-p1" }, data: { userId: u.id } }); // another Group is fine
    expect(await prisma.player.count({ where: { userId: u.id } })).toBe(2);
  });

  it("deleting a User keeps the claimed Player and its history (userId cleared)", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "member-a@example.test" } });
    await prisma.player.update({ where: { id: "ga-p1" }, data: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    const player = await prisma.player.findUniqueOrThrow({ where: { id: "ga-p1" } });
    expect(player.userId).toBeNull();
    expect(await prisma.teamGeneration.count({ where: { groupId: "ga" } })).toBe(1);
  });
});

describe("M6-A network safety", () => {
  it("no network call happened in this suite", () => {
    expect(networkCalls).toBe(0);
  });
});
