import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockPlayerFindMany = vi.fn();
const mockAppSettingFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) },
    appSetting: { findUnique: (...args: unknown[]) => mockAppSettingFindUnique(...args) },
  },
}));

import { POST } from "./route";

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function makePlayer(id: string) {
  return { id, firstName: "P", lastName: id, position: "MIDFIELDER", rating: "GOOD", stamina: 3 };
}

function req(body: unknown) {
  return new Request("http://localhost/api/admin/generate", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
  mockAppSettingFindUnique.mockResolvedValue(null);
});

describe("POST /api/admin/generate — cross-tenant player selection", () => {
  it("scopes the player lookup to the active group and succeeds when all requested ids resolve within it", async () => {
    const ids = ["p1", "p2", "p3", "p4"];
    mockPlayerFindMany.mockResolvedValue(ids.map(makePlayer));

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ids }));
    expect(res.status).toBe(200);

    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupId: "group-a", isActive: true }),
      })
    );
  });

  it("rejects when a requested id belongs to another group (findMany correctly returns fewer rows than requested)", async () => {
    const requestedIds = ["p1", "p2", "player-owned-by-group-b"];
    // The scoped where clause (groupId: 'group-a') means Group B's
    // player simply never comes back — this is what a real DB does.
    mockPlayerFindMany.mockResolvedValue([makePlayer("p1"), makePlayer("p2")]);

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: requestedIds }));
    expect(res.status).toBe(400);

    const bodyText = await res.text();
    expect(bodyText).not.toContain("group-b");
    expect(bodyText).not.toContain("player-owned-by-group-b");
  });

  it("rejects a fully mixed Group A + Group B selection the same way (no partial success)", async () => {
    const requestedIds = ["a1", "a2", "b1", "b2"];
    // Only the two Group-A ids resolve.
    mockPlayerFindMany.mockResolvedValue([makePlayer("a1"), makePlayer("a2")]);

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: requestedIds }));
    expect(res.status).toBe(400);
  });

  it("propagates UNAUTHENTICATED without ever touching the player table", async () => {
    const { TenantContextError } = await import("@/lib/tenantContext");
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }));
    expect(res.status).toBe(401);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });
});
