import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests the actual shipped route handlers (GET/POST in ./route.ts),
 * not a reimplementation. `requireTenantContext()` and the specific
 * Prisma methods this route calls are mocked; the assertions prove
 * both the HTTP outcome AND the exact `where`/`data` shape passed to
 * Prisma — i.e. that tenant scoping is real, not just "the response
 * looked right by coincidence."
 */

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
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

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/players", () => {
  it("scopes the query to the caller's active group", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([{ id: "p1", groupId: "group-a" }]);

    const res = await GET();
    expect(res.status).toBe(200);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
  });

  it("propagates a tenant-context failure as the mapped status, without ever querying players", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));

    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/players", () => {
  it("stamps groupId from server-side tenant context on create", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockCreate.mockResolvedValue({ id: "new-1", groupId: "group-a" });

    const req = new Request("http://localhost/api/admin/players", {
      method: "POST",
      body: JSON.stringify({ firstName: "Ana", lastName: "Lee", position: "MIDFIELDER", rating: "GOOD" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ groupId: "group-a" }) })
    );
  });

  it("ignores a client-supplied groupId entirely — the created row always uses the server's active group", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockCreate.mockResolvedValue({ id: "new-2", groupId: "group-a" });

    const req = new Request("http://localhost/api/admin/players", {
      method: "POST",
      // groupId here is attacker-controlled input trying to target another tenant.
      body: JSON.stringify({
        firstName: "Bob",
        lastName: "Smith",
        position: "DEFENDER",
        rating: "FAIR",
        groupId: "group-b",
      }),
    });

    await POST(req);

    const dataArg = mockCreate.mock.calls[0][0].data;
    expect(dataArg.groupId).toBe("group-a");
    expect(dataArg).not.toHaveProperty("groupId", "group-b");
  });
});
