import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockPlayerFindMany = vi.fn();
const mockAppSettingFindUnique = vi.fn();
const mockGroupSettingFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) },
    appSetting: { findUnique: (...args: unknown[]) => mockAppSettingFindUnique(...args) },
    groupSetting: { findUnique: (...args: unknown[]) => mockGroupSettingFindUnique(...args) },
  },
}));

import { POST } from "./route";
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

function makePlayer(id: string) {
  return { id, firstName: "P", lastName: id, position: "MIDFIELDER", rating: "GOOD", stamina: 3 };
}

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function req(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppSettingFindUnique.mockResolvedValue(null);
  mockGroupSettingFindUnique.mockResolvedValue(null);
});

describe("POST canonical generate — successful, scoped Generate", () => {
  it("resolves via the URL pair and scopes the player lookup to Group A", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    const ids = ["p1", "p2", "p3", "p4"];
    mockPlayerFindMany.mockResolvedValue(ids.map(makePlayer));

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ids }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupId: "group-a", isActive: true }) })
    );
  });
});

describe("POST canonical generate — foreign / mixed / inactive Player rejection", () => {
  it("rejects when a requested id belongs to another Group — the scoped query simply never returns it", async () => {
    const requestedIds = ["p1", "p2", "player-owned-by-group-b"];
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    // Scoped where clause (groupId: 'group-a') means Group B's player
    // never comes back — exactly what a real DB does.
    mockPlayerFindMany.mockResolvedValue([makePlayer("p1"), makePlayer("p2")]);

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: requestedIds }), ctx("org-a", "group-a"));
    expect(res.status).toBe(400);

    const bodyText = await res.text();
    expect(bodyText).not.toContain("group-b");
    expect(bodyText).not.toContain("player-owned-by-group-b");
  });

  it("rejects a fully mixed Group A + Group B selection the same way — no partial success", async () => {
    const requestedIds = ["a1", "a2", "b1", "b2"];
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    // Only the two Group-A ids resolve.
    mockPlayerFindMany.mockResolvedValue([makePlayer("a1"), makePlayer("a2")]);

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: requestedIds }), ctx("org-a", "group-a"));
    expect(res.status).toBe(400);
  });

  it("rejects when a requested Group-A id is inactive — the isActive-scoped query never returns it, generation never runs", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    // where includes isActive: true, so the inactive player id is
    // simply never returned — same mismatch-count rejection path.
    mockPlayerFindMany.mockResolvedValue([makePlayer("p1")]);

    const res = await POST(
      req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1", "inactive-player"] }),
      ctx("org-a", "group-a")
    );
    expect(res.status).toBe(400);
  });

  it("never lets a body-supplied groupId/organizationId influence tenant selection", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindMany.mockResolvedValue([makePlayer("p1"), makePlayer("p2")]);

    await POST(
      req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1", "p2"], groupId: "group-b", organizationId: "org-b" }),
      ctx("org-a", "group-a")
    );

    // generateTeamsSchema has no groupId/organizationId fields, and the
    // resolver is called with only the URL slugs — the malicious body
    // fields are never read anywhere.
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockPlayerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupId: "group-a" }) })
    );
  });
});

describe("POST canonical generate — invalid tenant fails closed before any Player/generation work", () => {
  it("unknown Organization -> generic canonical failure, Player never queried", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group -> identical generic canonical failure, Player never queried", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });

  it("unknown Organization and foreign Group produce the identical status + body (no existence leak)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("UNAUTHENTICATED still maps to 401", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1"] }), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
  });
});

describe("POST canonical generate — same Group slug across Organizations remains isolated", () => {
  it("org-a/indoor-soccer and org-b/indoor-soccer resolve and query independently", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    mockPlayerFindMany.mockResolvedValue([makePlayer("a1")]);
    await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["a1"] }), ctx("org-a", "indoor-soccer"));
    expect(mockPlayerFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: "group-a" }) }));

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    mockPlayerFindMany.mockResolvedValue([makePlayer("b1")]);
    await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["b1"] }), ctx("org-b", "indoor-soccer"));
    expect(mockPlayerFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: "group-b" }) }));
  });
});

describe("POST canonical generate — balanceWeights tenant scoping", () => {
  it("loads balancing weights from GroupSetting scoped to the URL-resolved active group, never AppSetting", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPlayerFindMany.mockResolvedValue([makePlayer("p1"), makePlayer("p2")]);
    mockGroupSettingFindUnique.mockResolvedValue({ value: JSON.stringify({ staminaCoef: 2 }) });

    const res = await POST(req({ teamCount: 2, date: "2026-09-28", selectedIds: ["p1", "p2"] }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);

    expect(mockGroupSettingFindUnique).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "balanceWeights" } },
    });
    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });
});
