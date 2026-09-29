import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

import { PATCH, DELETE } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function ctx(organizationSlug: string, groupSlug: string, id: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug, id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
});

describe("PATCH .../players/[id] — cross-tenant protection", () => {
  it("updates a player belonging to the URL-resolved active group", async () => {
    mockFindFirst.mockResolvedValue({ id: "p1" });
    mockUpdate.mockResolvedValue({ id: "p1", firstName: "Updated" });

    const req = new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ firstName: "Updated" }) });
    const res = await PATCH(req, ctx("org-a", "group-a", "p1"));

    expect(res.status).toBe(200);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", groupId: "group-a" } }));
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("a Group B player id under Group A's URL returns 404 (not 403), never mutates, and never leaks 'group-b'", async () => {
    // findFirst({id, groupId: 'group-a'}) finds nothing because this id
    // actually belongs to group-b — exactly what a real DB would do.
    mockFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ firstName: "Hacked" }) });
    const res = await PATCH(req, ctx("org-a", "group-a", "player-belonging-to-group-b"));

    expect(res.status).toBe(404);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("group-b");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("a fail-closed tenant resolution (unknown/foreign/inactive) never reaches the ownership check or update", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const req = new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ firstName: "X" }) });
    const res = await PATCH(req, ctx("org-a", "not-real-group", "p1"));

    expect(res.status).toBe(404);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE .../players/[id] — cross-tenant protection", () => {
  it("deletes a player belonging to the URL-resolved active group", async () => {
    mockFindFirst.mockResolvedValue({ id: "p1" });
    mockDelete.mockResolvedValue({ id: "p1" });

    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-a", "p1"));

    expect(res.status).toBe(200);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", groupId: "group-a" } }));
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("a Group B player id under Group A's URL returns 404, never deletes — cannot be deleted by guessing an id", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-a", "player-belonging-to-group-b"));

    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("a fail-closed tenant resolution never reaches the ownership check or delete", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await DELETE(new Request("http://localhost"), ctx("not-real-org", "group-a", "p1"));

    expect(res.status).toBe(404);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("PATCH .../players/[id] — full edit parity (Phase 2D.6D.5E.3)", () => {
  it("updates all six mutable fields; body groupId/organizationId never reach the update", async () => {
    mockFindFirst.mockResolvedValue({ id: "p1" });
    mockUpdate.mockResolvedValue({ id: "p1" });

    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({
        firstName: "New",
        lastName: "Name",
        position: "FORWARD",
        rating: "VERY_GOOD",
        stamina: 2,
        isActive: false,
        groupId: "group-b",
        organizationId: "org-b",
      }),
    });
    const res = await PATCH(req, ctx("org-a", "group-a", "p1"));
    expect(res.status).toBe(200);

    expect(mockFindFirst.mock.calls[0][0].where).toEqual({ id: "p1", groupId: "group-a" });
    expect(mockUpdate.mock.calls[0][0]).toEqual({
      where: { id: "p1" },
      data: { firstName: "New", lastName: "Name", position: "FORWARD", rating: "VERY_GOOD", stamina: 2, isActive: false },
    });
  });

  it("a full-field edit of a foreign Group's player is a generic 404 and never updates", async () => {
    mockFindFirst.mockResolvedValue(null);
    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ firstName: "X", lastName: "Y", position: "DEFENDER", rating: "FAIR", stamina: 1, isActive: true }),
    });
    const res = await PATCH(req, ctx("org-a", "group-a", "player-of-group-b"));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
