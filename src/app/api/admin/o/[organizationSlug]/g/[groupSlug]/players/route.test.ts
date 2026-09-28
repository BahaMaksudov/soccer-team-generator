import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockFindMany = vi.fn();
const mockCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

import { GET, POST } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

const GROUP_B = { id: "group-b", name: "B", slug: "group-b", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_B = {
  user: { id: "u2", email: "b@example.com", name: null },
  organization: { id: "org-b", name: "Org B", slug: "org-b" },
  membership: { id: "m2", role: "OWNER" as const },
  groups: [GROUP_B],
  activeGroup: GROUP_B,
};

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET .../players — cross-tenant isolation", () => {
  it("scopes the query to the URL-resolved active group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([{ id: "p1", groupId: "group-a" }]);

    const res = await GET(new Request("http://localhost"), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: "group-a" } }));
  });

  it("Group A's request never returns or queries Group B's players", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockFindMany.mockResolvedValue([{ id: "pb1", groupId: "group-b" }]);

    await GET(new Request("http://localhost"), ctx("org-b", "group-b"));

    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: "group-b" } }));
  });

  it("a fail-closed tenant resolution never queries Player at all, and returns a generic 404 (never 403/409)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await GET(new Request("http://localhost"), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("a foreign-Group URL also collapses to the identical generic 404 as an unknown Organization — same status, same body shape", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await GET(new Request("http://localhost"), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await GET(new Request("http://localhost"), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("UNAUTHENTICATED still maps to 401 (the one exception — carries no tenant-existence information)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET(new Request("http://localhost"), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
  });
});

describe("POST .../players — cross-tenant create protection", () => {
  it("stamps groupId from the URL-resolved tenant context on create", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockCreate.mockResolvedValue({ id: "new-1", groupId: "group-a" });

    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ firstName: "Ana", lastName: "Lee", position: "MIDFIELDER", rating: "GOOD" }),
    });

    const res = await POST(req, ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ groupId: "group-a" }) })
    );
  });

  it("a malicious body groupId cannot redirect the create target — server always uses the URL-resolved group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockCreate.mockResolvedValue({ id: "new-2", groupId: "group-a" });

    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Test",
        lastName: "Player",
        position: "MIDFIELDER",
        rating: "GOOD",
        groupId: "group-b",
      }),
    });

    await POST(req, ctx("org-a", "group-a"));

    const dataArg = mockCreate.mock.calls[0][0].data;
    expect(dataArg.groupId).toBe("group-a");
    expect(dataArg).not.toHaveProperty("groupId", "group-b");
  });

  it("a fail-closed tenant resolution never creates a Player", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ firstName: "X", lastName: "Y", position: "FORWARD", rating: "FAIR" }),
    });

    const res = await POST(req, ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("same group slug across different Organizations — full isolation", () => {
  it("org-a/indoor-soccer and org-b/indoor-soccer resolve and query independently", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    mockFindMany.mockResolvedValue([]);
    await GET(new Request("http://localhost"), ctx("org-a", "indoor-soccer"));
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-a" } }));

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    mockFindMany.mockResolvedValue([]);
    await GET(new Request("http://localhost"), ctx("org-b", "indoor-soccer"));
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-b" } }));
  });
});
