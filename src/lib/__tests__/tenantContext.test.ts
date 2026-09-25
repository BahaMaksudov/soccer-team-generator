import { describe, it, expect } from "vitest";
import {
  resolveTenantContextForEmail,
  resolveTenantContextForSlugs,
  listAccessibleTenantsForEmail,
  hasOrgRole,
  requireRole,
  tenantContextErrorStatus,
  TenantContextError,
  type TenantDataSource,
} from "../tenantContext";

type GroupFixture = {
  id: string;
  name: string;
  slug: string;
  sportKey: string;
  timezone: string;
  isActive: boolean;
};

type MembershipFixture = {
  id: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  organization: { id: string; name: string; slug: string; groups: GroupFixture[] };
};

function group(overrides: Partial<GroupFixture> = {}): GroupFixture {
  return {
    id: "group-1",
    name: "Indoor Soccer",
    slug: "indoor-soccer",
    sportKey: "soccer",
    timezone: "America/New_York",
    isActive: true,
    ...overrides,
  };
}

/** Builds a fixture data source. Deliberately no mocking framework —
 * plain functions closing over test-local data, matching the
 * TenantDataSource interface exactly. Extra fields (like a fake
 * passwordHash) can be attached to a user fixture to prove the
 * resolver never lets them leak into the returned context. */
function makeDb(opts: {
  users?: Record<string, { id: string; email: string; name: string | null; passwordHash?: string }>;
  memberships?: Record<string, MembershipFixture[]>;
}): TenantDataSource {
  return {
    user: {
      async findUnique({ where }) {
        return opts.users?.[where.email] ?? null;
      },
    },
    organizationMembership: {
      async findMany({ where }) {
        return opts.memberships?.[where.userId] ?? [];
      },
    },
  };
}

describe("resolveTenantContextForEmail — success", () => {
  it("resolves user → membership → organization → groups → activeGroup for the normal single-org, single-group case", async () => {
    const db = makeDb({
      users: {
        "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: "Bahrom Maksudov", passwordHash: "SHOULD_NEVER_LEAK" },
      },
      memberships: {
        "user-1": [
          {
            id: "membership-1",
            role: "OWNER",
            organization: { id: "org-1", name: "New England Eagles", slug: "new-england-eagles", groups: [group()] },
          },
        ],
      },
    });

    const ctx = await resolveTenantContextForEmail("admin@uccne.com", db);

    expect(ctx.user).toEqual({ id: "user-1", email: "admin@uccne.com", name: "Bahrom Maksudov" });
    expect(ctx.organization).toEqual({ id: "org-1", name: "New England Eagles", slug: "new-england-eagles" });
    expect(ctx.membership).toEqual({ id: "membership-1", role: "OWNER" });
    expect(ctx.groups).toHaveLength(1);
    expect(ctx.activeGroup).toEqual({
      id: "group-1", name: "Indoor Soccer", slug: "indoor-soccer", sportKey: "soccer", timezone: "America/New_York",
    });
  });

  it("normalizes email casing/whitespace before lookup, matching the login flow's own normalization", async () => {
    const db = makeDb({
      users: { "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: null } },
      memberships: {
        "user-1": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });
    const ctx = await resolveTenantContextForEmail("  ADMIN@UCCNE.COM  ", db);
    expect(ctx.user.id).toBe("user-1");
  });
});

describe("resolveTenantContextForEmail — UNAUTHENTICATED", () => {
  it("throws UNAUTHENTICATED for a null/undefined/empty email", async () => {
    const db = makeDb({});
    await expect(resolveTenantContextForEmail(null, db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveTenantContextForEmail(undefined, db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveTenantContextForEmail("   ", db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("resolveTenantContextForEmail — USER_NOT_FOUND", () => {
  it("throws USER_NOT_FOUND when the authenticated email has no matching User row", async () => {
    const db = makeDb({ users: {} });
    await expect(resolveTenantContextForEmail("nobody@example.com", db)).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });
});

describe("resolveTenantContextForEmail — NO_ORGANIZATION_MEMBERSHIP", () => {
  it("throws when the User exists but has zero OrganizationMembership rows", async () => {
    const db = makeDb({
      users: { "solo@example.com": { id: "user-2", email: "solo@example.com", name: null } },
      memberships: { "user-2": [] },
    });
    await expect(resolveTenantContextForEmail("solo@example.com", db)).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
  });
});

describe("resolveTenantContextForEmail — MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION", () => {
  it("fails closed rather than picking the first organization when a user belongs to more than one", async () => {
    const db = makeDb({
      users: { "multi@example.com": { id: "user-3", email: "multi@example.com", name: null } },
      memberships: {
        "user-3": [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "g-a" })] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "g-b" })] } },
        ],
      },
    });
    await expect(resolveTenantContextForEmail("multi@example.com", db)).rejects.toMatchObject({
      code: "MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION",
    });
  });
});

describe("resolveTenantContextForEmail — NO_GROUP", () => {
  it("fails closed when the organization has zero groups", async () => {
    const db = makeDb({
      users: { "nogroup@example.com": { id: "user-4", email: "nogroup@example.com", name: null } },
      memberships: {
        "user-4": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Empty Org", slug: "empty-org", groups: [] } }],
      },
    });
    await expect(resolveTenantContextForEmail("nogroup@example.com", db)).rejects.toMatchObject({ code: "NO_GROUP" });
  });

  it("treats a soft-disabled (isActive: false) group as if it doesn't exist — NO_GROUP, not a silent pick", async () => {
    const db = makeDb({
      users: { "disabled@example.com": { id: "user-5", email: "disabled@example.com", name: null } },
      memberships: {
        "user-5": [
          { id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group({ isActive: false })] } },
        ],
      },
    });
    await expect(resolveTenantContextForEmail("disabled@example.com", db)).rejects.toMatchObject({ code: "NO_GROUP" });
  });
});

describe("resolveTenantContextForEmail — MULTIPLE_GROUPS_REQUIRE_SELECTION", () => {
  it("fails closed rather than picking first/newest/oldest/alphabetical when multiple active groups exist", async () => {
    const db = makeDb({
      users: { "twogroups@example.com": { id: "user-6", email: "twogroups@example.com", name: null } },
      memberships: {
        "user-6": [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [group({ id: "g-a", slug: "a-group" }), group({ id: "g-b", slug: "b-group" })],
            },
          },
        ],
      },
    });
    await expect(resolveTenantContextForEmail("twogroups@example.com", db)).rejects.toMatchObject({
      code: "MULTIPLE_GROUPS_REQUIRE_SELECTION",
    });
  });
});

describe("resolveTenantContextForEmail — role foundation", () => {
  it("returns the actual OrgRole from the membership row, unmodified", async () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      const db = makeDb({
        users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
        memberships: { u1: [{ id: "m1", role, organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }] },
      });
      const ctx = await resolveTenantContextForEmail("u@example.com", db);
      expect(ctx.membership.role).toBe(role);
    }
  });
});

describe("safe DTO — sensitive fields never leak", () => {
  it("does not include passwordHash (or any field beyond the documented shape) even if the data source's raw row carries it", async () => {
    const db = makeDb({
      users: { "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: "Bahrom Maksudov", passwordHash: "$2b$10$totallyrealhashvalue" } },
      memberships: {
        "user-1": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });
    const ctx = await resolveTenantContextForEmail("admin@uccne.com", db);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("totallyrealhashvalue");
    expect(Object.keys(ctx.user).sort()).toEqual(["email", "id", "name"]);
  });
});

describe("cross-tenant principle — context is derived from membership, never from an arbitrary group id", () => {
  it("a user who is only a member of Org A can never resolve to Org B's group, even though Org B exists in the same data universe", async () => {
    // Two fully independent tenants exist in this fixture's "universe".
    const db = makeDb({
      users: {
        "alice@org-a.com": { id: "alice", email: "alice@org-a.com", name: "Alice" },
        "bob@org-b.com": { id: "bob", email: "bob@org-b.com", name: "Bob" },
      },
      memberships: {
        alice: [
          {
            id: "m-alice",
            role: "OWNER",
            organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "group-a", slug: "group-a", name: "A's Group" })] },
          },
        ],
        bob: [
          {
            id: "m-bob",
            role: "OWNER",
            organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "group-b", slug: "group-b", name: "B's Group" })] },
          },
        ],
      },
    });

    const aliceCtx = await resolveTenantContextForEmail("alice@org-a.com", db);
    const bobCtx = await resolveTenantContextForEmail("bob@org-b.com", db);

    expect(aliceCtx.activeGroup.id).toBe("group-a");
    expect(aliceCtx.organization.id).toBe("org-a");
    expect(bobCtx.activeGroup.id).toBe("group-b");
    expect(bobCtx.organization.id).toBe("org-b");

    // The resolver function has no groupId/organizationId parameter at
    // all — there is structurally no way to pass one in and have it
    // override what membership resolves to.
    expect(resolveTenantContextForEmail.length).toBe(2); // (email, db) only
  });
});

describe("role primitives", () => {
  const ctxWithRole = (role: "OWNER" | "ADMIN" | "MEMBER") => ({
    user: { id: "u1", email: "u@example.com", name: null },
    organization: { id: "o1", name: "Org", slug: "org" },
    membership: { id: "m1", role },
    groups: [],
    activeGroup: { id: "g1", name: "G", slug: "g", sportKey: "soccer", timezone: "America/New_York" },
  });

  it("hasOrgRole returns true only when the role is in the allowed list", () => {
    expect(hasOrgRole(ctxWithRole("OWNER") as any, ["OWNER"])).toBe(true);
    expect(hasOrgRole(ctxWithRole("MEMBER") as any, ["OWNER", "ADMIN"])).toBe(false);
  });

  it("requireRole throws TenantContextError('INSUFFICIENT_ROLE') when the role is not allowed", () => {
    expect(() => requireRole(ctxWithRole("MEMBER") as any, ["OWNER"])).toThrowError(TenantContextError);
    try {
      requireRole(ctxWithRole("MEMBER") as any, ["OWNER"]);
    } catch (e) {
      expect((e as TenantContextError).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("requireRole does not throw when the role is allowed", () => {
    expect(() => requireRole(ctxWithRole("OWNER") as any, ["OWNER", "ADMIN"])).not.toThrow();
  });
});

describe("tenantContextErrorStatus", () => {
  it("maps every error code to a deterministic HTTP status", () => {
    expect(tenantContextErrorStatus("UNAUTHENTICATED")).toBe(401);
    expect(tenantContextErrorStatus("USER_NOT_FOUND")).toBe(403);
    expect(tenantContextErrorStatus("NO_ORGANIZATION_MEMBERSHIP")).toBe(403);
    expect(tenantContextErrorStatus("INSUFFICIENT_ROLE")).toBe(403);
    expect(tenantContextErrorStatus("MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION")).toBe(409);
    expect(tenantContextErrorStatus("NO_GROUP")).toBe(409);
    expect(tenantContextErrorStatus("MULTIPLE_GROUPS_REQUIRE_SELECTION")).toBe(409);
  });
});

// =================================================================
// Phase 2D.6B — resolveTenantContextForSlugs()
// =================================================================

describe("resolveTenantContextForSlugs — success", () => {
  it("resolves the normal single-org, single-group case explicitly by slug", async () => {
    const db = makeDb({
      users: { "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: "Bahrom Maksudov" } },
      memberships: {
        "user-1": [
          {
            id: "membership-1",
            role: "OWNER",
            organization: { id: "org-1", name: "New England Eagles", slug: "new-england-eagles", groups: [group()] },
          },
        ],
      },
    });

    const ctx = await resolveTenantContextForSlugs(
      { email: "admin@uccne.com", organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" },
      db
    );

    expect(ctx.organization.slug).toBe("new-england-eagles");
    expect(ctx.activeGroup.slug).toBe("indoor-soccer");
    expect(ctx.membership).toEqual({ id: "membership-1", role: "OWNER" });
  });

  it("resolves each Group independently when the Organization has multiple active Groups — does NOT throw MULTIPLE_GROUPS_REQUIRE_SELECTION", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [
                group({ id: "g-soccer", slug: "soccer", name: "Soccer" }),
                group({ id: "g-basketball", slug: "basketball", name: "Basketball" }),
                group({ id: "g-volleyball", slug: "volleyball", name: "Volleyball" }),
              ],
            },
          },
        ],
      },
    });

    const soccer = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "soccer" }, db);
    const basketball = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "basketball" }, db);
    const volleyball = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "volleyball" }, db);

    expect(soccer.activeGroup.id).toBe("g-soccer");
    expect(basketball.activeGroup.id).toBe("g-basketball");
    expect(volleyball.activeGroup.id).toBe("g-volleyball");
  });

  it("resolves each Organization independently when the User belongs to multiple — does NOT throw MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION", async () => {
    const db = makeDb({
      users: { "multi@example.com": { id: "user-3", email: "multi@example.com", name: null } },
      memberships: {
        "user-3": [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "g-a" })] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "g-b" })] } },
        ],
      },
    });

    const a = await resolveTenantContextForSlugs({ email: "multi@example.com", organizationSlug: "org-a", groupSlug: "g-a" }, db);
    const b = await resolveTenantContextForSlugs({ email: "multi@example.com", organizationSlug: "org-b", groupSlug: "g-b" }, db);

    expect(a.organization.id).toBe("org-a");
    expect(b.organization.id).toBe("org-b");
  });

  it("resolves the correct Organization even when two different Organizations share the same Group slug", async () => {
    const db = makeDb({
      users: {
        "alice@org-a.com": { id: "alice", email: "alice@org-a.com", name: null },
      },
      memberships: {
        alice: [
          {
            id: "m-alice-a",
            role: "OWNER",
            organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "group-a", slug: "indoor-soccer" })] },
          },
          {
            id: "m-alice-b",
            role: "MEMBER",
            organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "group-b", slug: "indoor-soccer" })] },
          },
        ],
      },
    });

    const viaA = await resolveTenantContextForSlugs({ email: "alice@org-a.com", organizationSlug: "org-a", groupSlug: "indoor-soccer" }, db);
    const viaB = await resolveTenantContextForSlugs({ email: "alice@org-a.com", organizationSlug: "org-b", groupSlug: "indoor-soccer" }, db);

    expect(viaA.activeGroup.id).toBe("group-a");
    expect(viaA.organization.id).toBe("org-a");
    expect(viaB.activeGroup.id).toBe("group-b");
    expect(viaB.organization.id).toBe("org-b");
  });

  it("membership.role reflects the role for the SELECTED organization, not a global role (OWNER in A, MEMBER in B)", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "g-a" })] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "g-b" })] } },
        ],
      },
    });

    const asOwner = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org-a", groupSlug: "g-a" }, db);
    const asMember = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org-b", groupSlug: "g-b" }, db);

    expect(asOwner.membership.role).toBe("OWNER");
    expect(asMember.membership.role).toBe("MEMBER");
  });

  it("groups[] lists every active Group in the selected Organization, not merely the selected one", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [
                group({ id: "g-soccer", slug: "soccer" }),
                group({ id: "g-basketball", slug: "basketball" }),
              ],
            },
          },
        ],
      },
    });

    const ctx = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "soccer" }, db);

    expect(ctx.activeGroup.id).toBe("g-soccer");
    expect(ctx.groups.map((g) => g.id).sort()).toEqual(["g-basketball", "g-soccer"]);
  });

  it("groups[] excludes inactive Groups of the selected Organization", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [
                group({ id: "g-active", slug: "active-group", isActive: true }),
                group({ id: "g-inactive", slug: "inactive-group", isActive: false }),
              ],
            },
          },
        ],
      },
    });

    const ctx = await resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "active-group" }, db);

    expect(ctx.groups.map((g) => g.id)).toEqual(["g-active"]);
  });
});

describe("resolveTenantContextForSlugs — failure modes", () => {
  it("UNAUTHENTICATED for missing/empty email", async () => {
    const db = makeDb({});
    await expect(
      resolveTenantContextForSlugs({ email: null, organizationSlug: "org", groupSlug: "g" }, db)
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("USER_NOT_FOUND when the authenticated email has no matching User row", async () => {
    const db = makeDb({ users: {} });
    await expect(
      resolveTenantContextForSlugs({ email: "nobody@example.com", organizationSlug: "org", groupSlug: "g" }, db)
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("NO_ORGANIZATION_MEMBERSHIP for a completely unknown organization slug", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });

    await expect(
      resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "does-not-exist", groupSlug: "indoor-soccer" }, db)
    ).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
  });

  it("NO_ORGANIZATION_MEMBERSHIP — identical outcome for a REAL organization the user simply isn't a member of (indistinguishable from a nonexistent slug)", async () => {
    // "org-b" genuinely exists in this fixture's universe (bob is a
    // member) — but alice, the requester, has no membership in it.
    const db = makeDb({
      users: {
        "alice@example.com": { id: "alice", email: "alice@example.com", name: null },
        "bob@example.com": { id: "bob", email: "bob@example.com", name: null },
      },
      memberships: {
        alice: [{ id: "m-alice", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group()] } }],
        bob: [{ id: "m-bob", role: "OWNER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group()] } }],
      },
    });

    await expect(
      resolveTenantContextForSlugs({ email: "alice@example.com", organizationSlug: "org-b", groupSlug: "indoor-soccer" }, db)
    ).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
  });

  it("NO_GROUP for an unknown group slug within a real, accessible organization", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });

    await expect(
      resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "does-not-exist" }, db)
    ).rejects.toMatchObject({ code: "NO_GROUP" });
  });

  it("NO_GROUP — identical outcome for a Group that exists only under a DIFFERENT organization (never resolves Group by slug alone)", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "group-a" })] } },
          { id: "m-b", role: "OWNER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "group-b" })] } },
        ],
      },
    });

    // "group-b" is real, but only under org-b — requesting it under org-a must fail.
    await expect(
      resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org-a", groupSlug: "group-b" }, db)
    ).rejects.toMatchObject({ code: "NO_GROUP" });
  });

  it("NO_GROUP for an explicitly selected inactive Group — never silently substitutes another active Group", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [
                group({ id: "g-inactive", slug: "inactive-group", isActive: false }),
                group({ id: "g-active", slug: "active-group", isActive: true }),
              ],
            },
          },
        ],
      },
    });

    await expect(
      resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "org", groupSlug: "inactive-group" }, db)
    ).rejects.toMatchObject({ code: "NO_GROUP" });
  });

  it("does not accept organizationId/groupId as input — the function has no such parameters (structural proof)", () => {
    expect(resolveTenantContextForSlugs.length).toBe(2); // (params, db) only
  });
});

// =================================================================
// Phase 2D.6B — existing ambiguity behavior is unchanged (regression)
// =================================================================

describe("resolveTenantContextForEmail — unchanged ambiguity behavior after 2D.6B", () => {
  it("still throws MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION for the same multi-org data the new resolver handles explicitly", async () => {
    const db = makeDb({
      users: { "multi@example.com": { id: "user-3", email: "multi@example.com", name: null } },
      memberships: {
        "user-3": [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "g-a" })] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "g-b" })] } },
        ],
      },
    });

    await expect(resolveTenantContextForEmail("multi@example.com", db)).rejects.toMatchObject({
      code: "MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION",
    });
  });

  it("still throws MULTIPLE_GROUPS_REQUIRE_SELECTION for the same multi-group data the new resolver handles explicitly", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1",
              name: "Org",
              slug: "org",
              groups: [group({ id: "g-soccer", slug: "soccer" }), group({ id: "g-basketball", slug: "basketball" })],
            },
          },
        ],
      },
    });

    await expect(resolveTenantContextForEmail("u@example.com", db)).rejects.toMatchObject({
      code: "MULTIPLE_GROUPS_REQUIRE_SELECTION",
    });
  });
});

// =================================================================
// Phase 2D.6B — listAccessibleTenantsForEmail()
// =================================================================

describe("listAccessibleTenantsForEmail", () => {
  it("returns every Organization the User has membership in, with role and active Groups", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [group({ id: "g-a", slug: "g-a" })] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group({ id: "g-b", slug: "g-b" })] } },
        ],
      },
    });

    const list = await listAccessibleTenantsForEmail("u@example.com", db);

    expect(list).toHaveLength(2);
    expect(list.find((o) => o.id === "org-a")).toEqual({
      id: "org-a", name: "Org A", slug: "org-a", role: "OWNER",
      groups: [{ id: "g-a", name: "Indoor Soccer", slug: "g-a", sportKey: "soccer", timezone: "America/New_York" }],
    });
    expect(list.find((o) => o.id === "org-b")?.role).toBe("MEMBER");
  });

  it("preserves the per-Organization role correctly (OWNER in one, MEMBER in another)", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          { id: "m-a", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [] } },
          { id: "m-b", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [] } },
        ],
      },
    });

    const list = await listAccessibleTenantsForEmail("u@example.com", db);

    expect(list.find((o) => o.id === "org-a")?.role).toBe("OWNER");
    expect(list.find((o) => o.id === "org-b")?.role).toBe("MEMBER");
  });

  it("only includes active Groups within each Organization", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [
          {
            id: "m1",
            role: "OWNER",
            organization: {
              id: "o1", name: "Org", slug: "org",
              groups: [
                group({ id: "g-active", slug: "active-group", isActive: true }),
                group({ id: "g-inactive", slug: "inactive-group", isActive: false }),
              ],
            },
          },
        ],
      },
    });

    const list = await listAccessibleTenantsForEmail("u@example.com", db);

    expect(list[0].groups.map((g) => g.id)).toEqual(["g-active"]);
  });

  it("includes an Organization with zero active Groups, with groups: [] — distinguishable from having no Organization at all", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u1", email: "u@example.com", name: null } },
      memberships: {
        u1: [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Empty Org", slug: "empty-org", groups: [] } }],
      },
    });

    const list = await listAccessibleTenantsForEmail("u@example.com", db);

    expect(list).toEqual([{ id: "o1", name: "Empty Org", slug: "empty-org", role: "OWNER", groups: [] }]);
  });

  it("returns [] for a valid User with zero OrganizationMemberships — a listing result, not a thrown error", async () => {
    const db = makeDb({
      users: { "solo@example.com": { id: "user-2", email: "solo@example.com", name: null } },
      memberships: { "user-2": [] },
    });

    const list = await listAccessibleTenantsForEmail("solo@example.com", db);

    expect(list).toEqual([]);
  });

  it("still fails closed on authentication: UNAUTHENTICATED for missing email", async () => {
    const db = makeDb({});
    await expect(listAccessibleTenantsForEmail(null, db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("still fails closed on authentication: USER_NOT_FOUND for an unrecognized email", async () => {
    const db = makeDb({ users: {} });
    await expect(listAccessibleTenantsForEmail("nobody@example.com", db)).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("never leaks passwordHash even if the underlying user row carries one", async () => {
    const db = makeDb({
      users: { "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: "Bahrom Maksudov", passwordHash: "$2b$10$totallyrealhashvalue" } },
      memberships: {
        "user-1": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });

    const list = await listAccessibleTenantsForEmail("admin@uccne.com", db);

    expect(JSON.stringify(list)).not.toContain("passwordHash");
    expect(JSON.stringify(list)).not.toContain("totallyrealhashvalue");
  });
});
