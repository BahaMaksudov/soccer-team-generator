import { describe, it, expect } from "vitest";
import {
  resolveTenantContextForSlugs,
  listAccessibleTenantsForEmail,
  hasOrgRole,
  requireRole,
  resolveSessionUser,
  resolveSessionAccount,
  resolveOrganizationContextForSlug,
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
  users?: Record<string, { id: string; email: string; name: string | null; passwordHash?: string; emailVerifiedAt?: Date | null }>;
  memberships?: Record<string, MembershipFixture[]>;
}): TenantDataSource {
  return {
    user: {
      // M5: fixture Users are email-verified unless a test says otherwise.
      async findUnique({ where }) {
        const u = opts.users?.[where.email];
        return u ? { emailVerifiedAt: new Date("2026-01-01T00:00:00Z"), ...u } : null;
      },
    },
    organizationMembership: {
      async findMany({ where }) {
        return opts.memberships?.[where.userId] ?? [];
      },
    },
  };
}

// =================================================================
// Phase 2D.6D.6 — the single-tenant resolver (resolveTenantContextForEmail
// / requireTenantContext) and its "exactly one Organization / exactly
// one Group, else 409" tests were removed with it. The general security
// properties those tests also covered are kept below, now asserted
// against the URL-bound resolver that every Admin path uses.
// =================================================================

describe("resolveTenantContextForSlugs — email normalization", () => {
  it("normalizes email casing/whitespace before lookup, matching the login flow's own normalization", async () => {
    const db = makeDb({
      users: { "admin@uccne.com": { id: "user-1", email: "admin@uccne.com", name: null } },
      memberships: {
        "user-1": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", groups: [group()] } }],
      },
    });
    const ctx = await resolveTenantContextForSlugs(
      { email: "  ADMIN@UCCNE.COM  ", organizationSlug: "org", groupSlug: "indoor-soccer" },
      db
    );
    expect(ctx.user.id).toBe("user-1");
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
    const ctx = await resolveTenantContextForSlugs(
      { email: "admin@uccne.com", organizationSlug: "org", groupSlug: "indoor-soccer" },
      db
    );
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("totallyrealhashvalue");
    expect(Object.keys(ctx.user).sort()).toEqual(["email", "id", "name"]);
  });
});

describe("cross-tenant principle — context is derived from membership, never from an arbitrary id", () => {
  it("a user who is only a member of Org A can never resolve Org B's group, even by naming Org B's slugs", async () => {
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

    const aliceCtx = await resolveTenantContextForSlugs({ email: "alice@org-a.com", organizationSlug: "org-a", groupSlug: "group-a" }, db);
    const bobCtx = await resolveTenantContextForSlugs({ email: "bob@org-b.com", organizationSlug: "org-b", groupSlug: "group-b" }, db);
    expect(aliceCtx.activeGroup.id).toBe("group-a");
    expect(aliceCtx.organization.id).toBe("org-a");
    expect(bobCtx.activeGroup.id).toBe("group-b");
    expect(bobCtx.organization.id).toBe("org-b");

    await expect(
      resolveTenantContextForSlugs({ email: "alice@org-a.com", organizationSlug: "org-b", groupSlug: "group-b" }, db)
    ).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
  });

  it("membership with zero active Groups resolves no Group at all (no fallback)", async () => {
    const db = makeDb({
      users: { "u@example.com": { id: "u", email: "u@example.com", name: null } },
      memberships: {
        u: [{ id: "m", role: "OWNER", organization: { id: "o", name: "O", slug: "o", groups: [group({ isActive: false })] } }],
      },
    });
    await expect(
      resolveTenantContextForSlugs({ email: "u@example.com", organizationSlug: "o", groupSlug: "indoor-soccer" }, db)
    ).rejects.toMatchObject({ code: "NO_GROUP" });
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

  it("resolves each Group independently when the Organization has multiple active Groups — no ambiguity, the URL selects", async () => {
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

  it("resolves each Organization independently when the User belongs to multiple — no ambiguity, the URL selects", async () => {
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

// =================================================================
// M5 — session identity binding and Organization-level resolution
// =================================================================

describe("M5 — resolveSessionUser binds the session to one User row", () => {
  const db = makeDb({ users: { "a@example.com": { id: "user-a", email: "a@example.com", name: "A", passwordHash: "$2b$12$x" } } });

  it("resolves by normalized email and returns only id/email/name", async () => {
    const u = await resolveSessionUser({ email: " A@Example.com ", userId: "user-a" }, db);
    expect(u).toEqual({ id: "user-a", email: "a@example.com", name: "A" });
  });

  it("pre-M5 sessions without an id still resolve by email", async () => {
    expect((await resolveSessionUser({ email: "a@example.com" }, db)).id).toBe("user-a");
  });

  it("a session id that does not match the User found by email fails closed (USER_NOT_FOUND)", async () => {
    await expect(resolveSessionUser({ email: "a@example.com", userId: "someone-else" }, db)).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("the same binding applies to the Group resolver and the /admin listing", async () => {
    const withOrg = makeDb({
      users: { "a@example.com": { id: "user-a", email: "a@example.com", name: null } },
      memberships: { "user-a": [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "O", slug: "o", groups: [group()] } }] },
    });
    await expect(
      resolveTenantContextForSlugs({ email: "a@example.com", userId: "stale-id", organizationSlug: "o", groupSlug: "indoor-soccer" }, withOrg)
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    await expect(listAccessibleTenantsForEmail("a@example.com", withOrg, "stale-id")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(await listAccessibleTenantsForEmail("a@example.com", withOrg, "user-a")).toHaveLength(1);
  });

  it("UNAUTHENTICATED without an email", async () => {
    await expect(resolveSessionUser({ email: null, userId: "user-a" }, db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("M5 — resolveOrganizationContextForSlug", () => {
  const db = makeDb({
    users: {
      "alice@a.com": { id: "alice", email: "alice@a.com", name: "Alice" },
      "bob@b.com": { id: "bob", email: "bob@b.com", name: "Bob" },
    },
    memberships: {
      alice: [{ id: "ma", role: "OWNER", organization: { id: "org-a", name: "Org A", slug: "org-a", groups: [] } }],
      bob: [{ id: "mb", role: "MEMBER", organization: { id: "org-b", name: "Org B", slug: "org-b", groups: [group()] } }],
    },
  });

  it("returns the User's own membership role for the URL-selected Organization", async () => {
    const ctx = await resolveOrganizationContextForSlug({ email: "alice@a.com", organizationSlug: "org-a" }, db);
    expect(ctx).toEqual({
      user: { id: "alice", email: "alice@a.com", name: "Alice" },
      organization: { id: "org-a", name: "Org A", slug: "org-a" },
      membership: { id: "ma", role: "OWNER" },
    });
  });

  it("another Organization and an unknown slug are the same NO_ORGANIZATION_MEMBERSHIP outcome", async () => {
    const foreign = resolveOrganizationContextForSlug({ email: "alice@a.com", organizationSlug: "org-b" }, db);
    const unknown = resolveOrganizationContextForSlug({ email: "alice@a.com", organizationSlug: "nope" }, db);
    await expect(foreign).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
    await expect(unknown).rejects.toMatchObject({ code: "NO_ORGANIZATION_MEMBERSHIP" });
  });

  it("requireRole(OWNER) rejects a MEMBER", async () => {
    const ctx = await resolveOrganizationContextForSlug({ email: "bob@b.com", organizationSlug: "org-b" }, db);
    expect(() => requireRole(ctx, ["OWNER"])).toThrow(TenantContextError);
  });
});

describe("M5 — the verified-email rule is enforced centrally (DB value, never the session)", () => {
  const db = makeDb({
    users: { "new@example.com": { id: "u-new", email: "new@example.com", name: "New", emailVerifiedAt: null } },
    memberships: { "u-new": [{ id: "m", role: "OWNER", organization: { id: "o", name: "O", slug: "o", groups: [group()] } }] },
  });

  it("an unverified User is refused by every tenant resolver with EMAIL_NOT_VERIFIED", async () => {
    await expect(resolveSessionUser({ email: "new@example.com" }, db)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    await expect(
      resolveTenantContextForSlugs({ email: "new@example.com", organizationSlug: "o", groupSlug: "indoor-soccer" }, db)
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    await expect(resolveOrganizationContextForSlug({ email: "new@example.com", organizationSlug: "o" }, db)).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    await expect(listAccessibleTenantsForEmail("new@example.com", db)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("resolveSessionAccount (verification flow only) still identifies the unverified User", async () => {
    expect(await resolveSessionAccount({ email: "new@example.com" }, db)).toEqual({
      id: "u-new",
      email: "new@example.com",
      name: "New",
      emailVerified: false,
    });
  });
});
