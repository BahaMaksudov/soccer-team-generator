import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrgFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();
const mockPlayerFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: (...args: unknown[]) => mockOrgFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
    player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) },
  },
}));

import { GET } from "./route";

const ORG_A = { id: "org-a", name: "New England Eagles", slug: "new-england-eagles" };
const GROUP_A = {
  id: "group-a",
  name: "Indoor Soccer A",
  slug: "indoor-soccer",
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

const ORG_B = { id: "org-b", name: "Boston Rovers", slug: "boston-rovers" };
const GROUP_B = {
  id: "group-b",
  name: "Rovers Indoor",
  slug: "indoor-soccer", // same slug as GROUP_A, different org
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/players — resolver gate", () => {
  it("unknown organization slug -> 404, Player is never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("does-not-exist", "indoor-soccer"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });

  it("unknown group slug under a real organization -> 404, Player is never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "does-not-exist"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });

  it("a group belonging to a DIFFERENT organization than the URL claims -> 404, no data leak", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null); // Group.findUnique({organizationId: org-a, slug: group-b's slug}) finds nothing

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "belongs-to-org-b"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });

  it("an inactive group -> 404, no Player query, no separate active-status policy invented", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue({ ...GROUP_A, isActive: false });

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/players — two-group tenant isolation", () => {
  it("scopes the Player query to the resolved group's id", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockPlayerFindMany.mockResolvedValue([{ id: "a1", firstName: "Alice", lastName: "A", position: "MIDFIELDER", isActive: true }]);

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    expect(res.status).toBe(200);

    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
  });

  it("resolves the correct Group even when two organizations share the same group slug", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockPlayerFindMany.mockResolvedValue([]);

    await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));

    expect(mockGroupFindUnique).toHaveBeenCalledWith({
      where: { organizationId_slug: { organizationId: "org-a", slug: "indoor-soccer" } },
    });
  });

  it("Group B's request never returns or queries Group A's players", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_B);
    mockGroupFindUnique.mockResolvedValue(GROUP_B);
    mockPlayerFindMany.mockResolvedValue([{ id: "b1", firstName: "Bob", lastName: "B", position: "FORWARD", isActive: true }]);

    const res = await GET(new Request("http://localhost"), ctx("boston-rovers", "indoor-soccer"));
    const json = await res.json();

    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-b" } })
    );
    expect(json).toEqual([{ id: "b1", firstName: "Bob", lastName: "B", position: "FORWARD", isActive: true }]);
  });

  it("a client-supplied groupId query param cannot redirect the query target", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockPlayerFindMany.mockResolvedValue([]);

    await GET(
      new Request("http://localhost/api/public/new-england-eagles/indoor-soccer/players?groupId=group-b"),
      ctx("new-england-eagles", "indoor-soccer")
    );

    const call = mockPlayerFindMany.mock.calls[0][0];
    expect(call.where.groupId).toBe("group-a");
  });
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/players — public DTO", () => {
  it("returns only id, firstName, lastName, position, isActive — never groupId, rating, or stamina", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockPlayerFindMany.mockResolvedValue([
      { id: "a1", firstName: "Alice", lastName: "A", position: "MIDFIELDER", isActive: true },
    ]);

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    const json = await res.json();

    expect(json).toEqual([
      { id: "a1", firstName: "Alice", lastName: "A", position: "MIDFIELDER", isActive: true },
    ]);

    // Assert the Prisma `select` itself never requests these fields —
    // proves the server never even fetches them, not just that the
    // response happens not to include them.
    const call = mockPlayerFindMany.mock.calls[0][0];
    expect(call.select).toEqual({
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      isActive: true,
    });
    expect(call.select.groupId).toBeUndefined();
    expect(call.select.rating).toBeUndefined();
    expect(call.select.stamina).toBeUndefined();
  });

  it("returns both active and inactive players (no isActive filter), matching legacy /api/public/players semantics", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockPlayerFindMany.mockResolvedValue([]);

    await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));

    const call = mockPlayerFindMany.mock.calls[0][0];
    expect(call.where).toEqual({ groupId: "group-a" }); // no isActive key at all
  });
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/players — read-only surface", () => {
  it("exports no mutation handlers", async () => {
    const routeModule = await import("./route");
    expect((routeModule as Record<string, unknown>).POST).toBeUndefined();
    expect((routeModule as Record<string, unknown>).PUT).toBeUndefined();
    expect((routeModule as Record<string, unknown>).PATCH).toBeUndefined();
    expect((routeModule as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
