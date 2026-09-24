import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolvePublicGroup, type PublicGroupDataSource } from "../publicGroup";

type OrgFixture = { id: string; name: string; slug: string };
type GroupFixture = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  sportKey: string;
  timezone: string;
  isActive: boolean;
};

/** Builds a fixture data source. No mocking framework needed for the
 * lookups themselves — plain functions closing over test-local data,
 * matching PublicGroupDataSource exactly, the same pattern used for
 * TenantDataSource in tenantContext.test.ts. */
function makeDb(opts: { orgs?: OrgFixture[]; groups?: GroupFixture[] }): PublicGroupDataSource {
  const orgs = opts.orgs ?? [];
  const groups = opts.groups ?? [];
  return {
    organization: {
      async findUnique({ where }) {
        return orgs.find((o) => o.slug === where.slug) ?? null;
      },
    },
    group: {
      async findUnique({ where }) {
        const { organizationId, slug } = where.organizationId_slug;
        return groups.find((g) => g.organizationId === organizationId && g.slug === slug) ?? null;
      },
    },
  };
}

const ORG_A: OrgFixture = { id: "org-a", name: "New England Eagles", slug: "new-england-eagles" };
const ORG_B: OrgFixture = { id: "org-b", name: "Boston Rovers", slug: "boston-rovers" };

const GROUP_A: GroupFixture = {
  id: "group-a",
  organizationId: "org-a",
  name: "Indoor Soccer",
  slug: "indoor-soccer",
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

describe("resolvePublicGroup", () => {
  it("resolves a valid organizationSlug + groupSlug pair", async () => {
    const db = makeDb({ orgs: [ORG_A], groups: [GROUP_A] });

    const ctx = await resolvePublicGroup(
      { organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" },
      db
    );

    expect(ctx).toEqual({
      organization: { id: "org-a", name: "New England Eagles", slug: "new-england-eagles" },
      group: {
        id: "group-a",
        name: "Indoor Soccer",
        slug: "indoor-soccer",
        sportKey: "soccer",
        timezone: "America/New_York",
      },
    });
  });

  it("returns null for an unknown organization slug — never accidentally resolves another organization", async () => {
    const db = makeDb({ orgs: [ORG_A], groups: [GROUP_A] });

    const ctx = await resolvePublicGroup(
      { organizationSlug: "does-not-exist", groupSlug: "indoor-soccer" },
      db
    );

    expect(ctx).toBeNull();
  });

  it("returns null for an unknown group slug under a real organization", async () => {
    const db = makeDb({ orgs: [ORG_A], groups: [GROUP_A] });

    const ctx = await resolvePublicGroup(
      { organizationSlug: "new-england-eagles", groupSlug: "does-not-exist" },
      db
    );

    expect(ctx).toBeNull();
  });

  it("returns null when the group belongs to a DIFFERENT organization than the URL claims", async () => {
    const GROUP_B: GroupFixture = {
      id: "group-b",
      organizationId: "org-b",
      name: "Rovers 5-a-side",
      slug: "five-a-side",
      sportKey: "soccer",
      timezone: "America/New_York",
      isActive: true,
    };
    const db = makeDb({ orgs: [ORG_A, ORG_B], groups: [GROUP_A, GROUP_B] });

    // Org A's real slug, but Group B's real slug (which belongs to Org B)
    const ctx = await resolvePublicGroup(
      { organizationSlug: "new-england-eagles", groupSlug: "five-a-side" },
      db
    );

    expect(ctx).toBeNull();
  });

  it("resolves the correct Group when two different organizations both have a group with the same slug", async () => {
    const GROUP_B_SAME_SLUG: GroupFixture = {
      id: "group-b",
      organizationId: "org-b",
      name: "Rovers Indoor",
      slug: "indoor-soccer", // same slug as GROUP_A, different org
      sportKey: "soccer",
      timezone: "America/New_York",
      isActive: true,
    };
    const db = makeDb({ orgs: [ORG_A, ORG_B], groups: [GROUP_A, GROUP_B_SAME_SLUG] });

    const ctxA = await resolvePublicGroup(
      { organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" },
      db
    );
    const ctxB = await resolvePublicGroup(
      { organizationSlug: "boston-rovers", groupSlug: "indoor-soccer" },
      db
    );

    expect(ctxA?.group.id).toBe("group-a");
    expect(ctxB?.group.id).toBe("group-b");
  });

  it("returns null for an inactive group", async () => {
    const INACTIVE_GROUP: GroupFixture = { ...GROUP_A, isActive: false };
    const db = makeDb({ orgs: [ORG_A], groups: [INACTIVE_GROUP] });

    const ctx = await resolvePublicGroup(
      { organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" },
      db
    );

    expect(ctx).toBeNull();
  });

  it("imports nothing from next-auth or tenantContext.ts — not just untested, structurally absent", () => {
    const source = readFileSync(new URL("../publicGroup.ts", import.meta.url), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import "));

    for (const line of importLines) {
      expect(line).not.toMatch(/next-auth/);
      expect(line).not.toMatch(/tenantContext/);
    }
    expect(source).not.toMatch(/getServerSession\(/);
    expect(source).not.toMatch(/requireTenantContext\(/);
  });
});
