import { describe, it, expect } from "vitest";
import {
  resolveTenantContextForEmail,
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
