/**
 * UI-3 — REAL-DATABASE tests for the authenticated shell's data: identity
 * and the User's OWN memberships only, never another tenant's data.
 * Guarded local TEST database only; read-only use of the loader.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadShellDataFor, type ShellDataSource } from "@/lib/appShellData";

const VERIFIED = new Date("2026-10-01T00:00:00Z");
const db = prisma as unknown as ShellDataSource;

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "TelegramConnectCode","PlayerClaim","EmailVerificationToken","OrganizationInvitation","TelegramPollAnswer","TelegramPoll","TelegramUserLink","TelegramChat","TeamGeneration","GroupSetting","Player","Group","OrganizationMembership","Organization","User","AppSetting" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({
    data: [
      { id: "u-owner", email: "owner@example.test", name: "Owner", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-member", email: "member@example.test", name: "Member", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-player", email: "player@example.test", name: "Player Only", passwordHash: null, emailVerifiedAt: VERIFIED },
      { id: "u-unverified", email: "unverified@example.test", name: null, passwordHash: null },
    ],
  });
  for (const slug of ["org-a", "org-b", "org-c"]) await prisma.organization.create({ data: { id: slug, name: slug.toUpperCase(), slug, plan: "LEGACY" } });
  await prisma.group.createMany({
    data: [
      { id: "a1", organizationId: "org-a", name: "A One", slug: "one", sportKey: "soccer", timezone: "UTC" },
      { id: "a2", organizationId: "org-a", name: "A Two", slug: "two", sportKey: "basketball", timezone: "UTC" },
      { id: "a3", organizationId: "org-a", name: "A Archived", slug: "old", sportKey: "soccer", timezone: "UTC", isActive: false },
      { id: "b1", organizationId: "org-b", name: "B One", slug: "one", sportKey: "soccer", timezone: "UTC" },
      { id: "c1", organizationId: "org-c", name: "C Secret", slug: "secret", sportKey: "soccer", timezone: "UTC" },
    ],
  });
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-owner", organizationId: "org-a", role: "OWNER" },
      { userId: "u-owner", organizationId: "org-b", role: "MEMBER" },
      { userId: "u-member", organizationId: "org-b", role: "MEMBER" },
      { userId: "u-unverified", organizationId: "org-c", role: "OWNER" },
    ],
  });
  // A claimed Player profile in a Group whose Organization the player is NOT a member of.
  await prisma.player.create({ data: { id: "p1", groupId: "c1", userId: "u-player", firstName: "P", lastName: "O", position: "DEFENDER", rating: "GOOD", stamina: 3 } });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db: name }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(name)) throw new Error(`Connected to '${name}' — aborting.`);
});
beforeEach(seed);
afterAll(() => prisma.$disconnect());

describe("UI-3 shell data", () => {
  it("unauthenticated / unknown session → no shell data", async () => {
    expect(await loadShellDataFor(null, db)).toBeNull();
    expect(await loadShellDataFor({ email: "nobody@example.test" }, db)).toBeNull();
    expect(await loadShellDataFor({ email: "owner@example.test", id: "u-member" }, db)).toBeNull();
  });

  it("an OWNER sees exactly their memberships, real roles and ACTIVE groups — never other tenants", async () => {
    const d = await loadShellDataFor({ email: "owner@example.test", id: "u-owner" }, db);
    expect(d?.organizations.map((o) => [o.slug, o.role, o.groups.map((g) => g.slug)]).sort()).toEqual([
      ["org-a", "OWNER", ["one", "two"]],
      ["org-b", "MEMBER", ["one"]],
    ]);
    expect(JSON.stringify(d)).not.toMatch(/org-c|secret|old|Archived/);
    expect(d?.workspaceListAvailable).toBe(true);
    expect(d?.hasPlayerProfile).toBe(false);
  });

  it("a MEMBER of one single-group organization: just that group; /admin would redirect so no Groups link", async () => {
    const d = await loadShellDataFor({ email: "member@example.test", id: "u-member" }, db);
    expect(d?.organizations).toEqual([{ slug: "org-b", name: "ORG-B", role: "MEMBER", groups: [{ slug: "one", name: "B One", sportLabel: "Soccer" }] }]);
    expect(d?.workspaceListAvailable).toBe(false);
  });

  it("a claimed Player profile adds My Games only — it grants no organization or group", async () => {
    const d = await loadShellDataFor({ email: "player@example.test", id: "u-player" }, db);
    expect(d).toMatchObject({ organizations: [], hasPlayerProfile: true, workspaceListAvailable: false });
  });

  it("an unverified account gets no tenant data (central verified-email rule)", async () => {
    const d = await loadShellDataFor({ email: "unverified@example.test", id: "u-unverified" }, db);
    expect(d).toMatchObject({ organizations: [], hasPlayerProfile: false });
  });

  it("loading shell data writes nothing", async () => {
    const count = async () => [await prisma.user.count(), await prisma.player.count(), await prisma.organizationMembership.count()].join(",");
    const before = await count();
    await loadShellDataFor({ email: "owner@example.test", id: "u-owner" }, db);
    expect(await count()).toBe(before);
  });
});
