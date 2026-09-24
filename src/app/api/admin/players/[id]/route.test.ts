import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
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

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
});

describe("PATCH /api/admin/players/[id] — cross-tenant protection", () => {
  it("updates a player that belongs to the caller's active group", async () => {
    mockFindFirst.mockResolvedValue({ id: "p1" });
    mockUpdate.mockResolvedValue({ id: "p1", firstName: "Updated" });

    const req = new Request("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ firstName: "Updated" }),
    });

    const res = await PATCH(req as any, ctx("p1"));
    expect(res.status).toBe(200);

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1", groupId: "group-a" } })
    );
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("returns 404 — not 403 — for a Group B player id, and never calls update", async () => {
    // findFirst with {id, groupId: 'group-a'} finds nothing because this
    // id belongs to a different group — exactly what a real DB would do.
    mockFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ firstName: "Hacked" }),
    });

    const res = await PATCH(req as any, ctx("player-belonging-to-group-b"));
    expect(res.status).toBe(404);

    const bodyText = await res.text();
    expect(bodyText).not.toContain("group-b");
    expect(bodyText).not.toContain("another tenant");
    expect(bodyText).not.toContain("403");

    // The critical assertion: the mutation itself must never run.
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/players/[id] — cross-tenant protection", () => {
  it("deletes a player that belongs to the caller's active group", async () => {
    mockFindFirst.mockResolvedValue({ id: "p1" });
    mockDelete.mockResolvedValue({ id: "p1" });

    const res = await DELETE(new Request("http://localhost/x") as any, ctx("p1"));
    expect(res.status).toBe(200);
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1", groupId: "group-a" } })
    );
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("returns 404 for a Group B player id, and never calls delete — cannot be deleted by guessing an id", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await DELETE(new Request("http://localhost/x") as any, ctx("player-belonging-to-group-b"));
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
