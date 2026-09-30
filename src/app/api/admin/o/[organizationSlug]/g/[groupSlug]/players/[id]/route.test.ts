import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

// In-memory Player table: where clauses are applied exactly like a single
// SQL statement would apply them, so tests can prove the OTHER Group's
// row is untouched (not merely that a mock wasn't called).
type Row = {
  id: string;
  groupId: string;
  firstName: string;
  lastName: string;
  position: string;
  rating: string;
  stamina: number;
  isActive: boolean;
};
let rows: Row[];
const matches = (r: Row, where: Partial<Row>) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);
const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const mockFindFirst = vi.fn(async ({ where }: { where: Partial<Row> }) => {
  const r = rows.find((x) => matches(x, where));
  return r ? { ...r } : null;
});
const mockUpdateMany = vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
  let count = 0;
  for (const r of rows) if (matches(r, where)) (Object.assign(r, clean(data)), count++);
  return { count };
});
const mockDeleteMany = vi.fn(async ({ where }: { where: Partial<Row> }) => {
  const before = rows.length;
  rows = rows.filter((r) => !matches(r, where));
  return { count: before - rows.length };
});
// Must never be used any more (id-only writes).
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: {
      findFirst: (...a: [never]) => mockFindFirst(...a),
      updateMany: (...a: [never]) => mockUpdateMany(...a),
      deleteMany: (...a: [never]) => mockDeleteMany(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
  },
}));

import { PATCH, DELETE } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const group = (id: string) => ({ id, name: id, slug: id, sportKey: "soccer", timezone: "America/New_York" });
const context = (g: string) => ({
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [group(g)],
  activeGroup: group(g),
});
const CONTEXT_A = context("group-a");
const CONTEXT_B = context("group-b");

const A_PLAYER: Row = { id: "pa1", groupId: "group-a", firstName: "Doni", lastName: "Alpha", position: "MIDFIELDER", rating: "EXCELLENT", stamina: 5, isActive: true };
const B_PLAYER: Row = { id: "pb1", groupId: "group-b", firstName: "test", lastName: "four", position: "FORWARD", rating: "GOOD", stamina: 3, isActive: true };

function ctx(organizationSlug: string, groupSlug: string, id: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug, id }) };
}
const patch = (body: unknown) => new Request("http://localhost", { method: "PATCH", body: JSON.stringify(body) });
const snapshot = () => JSON.stringify(rows);

beforeEach(() => {
  vi.clearAllMocks();
  rows = [{ ...A_PLAYER }, { ...B_PLAYER }];
  mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
});

describe("PATCH .../players/[id] — cross-tenant protection (Group-scoped mutation, Phase 2D.6E.6C)", () => {
  it("updates a player belonging to the URL-resolved active group, via one id+groupId-scoped mutation", async () => {
    const res = await PATCH(patch({ firstName: "Updated" }), ctx("org-a", "group-a", "pa1"));

    expect(res.status).toBe(200);
    expect((await res.json()).firstName).toBe("Updated");
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: "pa1", groupId: "group-a" }, data: expect.any(Object) });
    // Read-back is Group-scoped too — never by id alone.
    expect(mockFindFirst).toHaveBeenLastCalledWith({ where: { id: "pa1", groupId: "group-a" } });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("a Group A player id under Group B's URL returns 404, changes NO row, and never leaks Group A", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    const before = snapshot();

    const res = await PATCH(patch({ firstName: "Hacked", stamina: 1 }), ctx("org-a", "group-b", "pa1"));

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "Player not found" }));
    expect(text).not.toMatch(/group-a|Doni|Alpha/);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({ id: "pa1", groupId: "group-b" });
    expect(snapshot()).toBe(before); // Group A and Group B rows unchanged
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("a Group B player id under Group A's URL returns 404 (not 403), never mutates, and never leaks 'group-b'", async () => {
    const before = snapshot();
    const res = await PATCH(patch({ firstName: "Hacked" }), ctx("org-a", "group-a", "pb1"));

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("group-b");
    expect(snapshot()).toBe(before);
  });

  it("a valid Group B PATCH still succeeds and leaves Group A untouched", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    const res = await PATCH(patch({ stamina: 4 }), ctx("org-a", "group-b", "pb1"));

    expect(res.status).toBe(200);
    expect(rows.find((r) => r.id === "pb1")!.stamina).toBe(4);
    expect(rows.find((r) => r.id === "pa1")).toEqual(A_PLAYER);
  });

  it("an empty body is a no-op: own player returns 200 without writing; a foreign id still returns 404", async () => {
    const own = await PATCH(patch({}), ctx("org-a", "group-a", "pa1"));
    expect(own.status).toBe(200);
    expect(mockUpdateMany).not.toHaveBeenCalled();

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    const foreign = await PATCH(patch({}), ctx("org-a", "group-b", "pa1"));
    expect(foreign.status).toBe(404);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("a fail-closed tenant resolution (unknown/foreign/inactive) never reaches any Player query", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await PATCH(patch({ firstName: "X" }), ctx("org-a", "not-real-group", "pa1"));

    expect(res.status).toBe(404);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("an unexpected database error returns a generic 500 — never the raw error message", async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error('Invalid `prisma.player.updateMany()` invocation: secret internals'));
    const res = await PATCH(patch({ firstName: "X" }), ctx("org-a", "group-a", "pa1"));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "Failed to update player" }));
    expect(text).not.toMatch(/prisma|internals|invocation/);
  });
});

describe("DELETE .../players/[id] — cross-tenant protection (Group-scoped mutation, Phase 2D.6E.6C)", () => {
  it("deletes a player belonging to the URL-resolved active group via deleteMany({ id, groupId })", async () => {
    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-a", "pa1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "pa1", groupId: "group-a" } });
    expect(rows.map((r) => r.id)).toEqual(["pb1"]);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("a Group A player id under Group B's URL returns 404 and the Group A player still exists, unchanged", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    const before = snapshot();

    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-b", "pa1"));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "Player not found" }));
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "pa1", groupId: "group-b" } });
    expect(snapshot()).toBe(before);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("a Group B player id under Group A's URL returns 404, never deletes — cannot be deleted by guessing an id", async () => {
    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-a", "pb1"));

    expect(res.status).toBe(404);
    expect(rows.find((r) => r.id === "pb1")).toEqual(B_PLAYER);
  });

  it("a valid Group B DELETE removes only the Group B player", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-b", "pb1"));

    expect(res.status).toBe(200);
    expect(rows).toEqual([A_PLAYER]);
  });

  it("a fail-closed tenant resolution never reaches any Player query", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await DELETE(new Request("http://localhost"), ctx("not-real-org", "group-a", "pa1"));

    expect(res.status).toBe(404);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("an unexpected database error returns a generic 500 — never the raw error message", async () => {
    mockDeleteMany.mockRejectedValueOnce(new Error("Foreign key constraint failed on the field: secret"));
    const res = await DELETE(new Request("http://localhost"), ctx("org-a", "group-a", "pa1"));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: "Failed to delete player" }));
  });
});

describe("PATCH .../players/[id] — full edit parity (Phase 2D.6D.5E.3)", () => {
  it("updates all six mutable fields; body groupId/organizationId never reach the mutation", async () => {
    const res = await PATCH(
      patch({ firstName: "New", lastName: "Name", position: "FORWARD", rating: "VERY_GOOD", stamina: 2, isActive: false, groupId: "group-b", organizationId: "org-b" }),
      ctx("org-a", "group-a", "pa1")
    );
    expect(res.status).toBe(200);

    expect(mockUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "pa1", groupId: "group-a" },
      data: { firstName: "New", lastName: "Name", position: "FORWARD", rating: "VERY_GOOD", stamina: 2, isActive: false },
    });
    expect(rows.find((r) => r.id === "pa1")!.groupId).toBe("group-a");
  });

  it("a full-field edit of a foreign Group's player is a generic 404 and changes nothing", async () => {
    const before = snapshot();
    const res = await PATCH(
      patch({ firstName: "X", lastName: "Y", position: "DEFENDER", rating: "FAIR", stamina: 1, isActive: true }),
      ctx("org-a", "group-a", "pb1")
    );
    expect(res.status).toBe(404);
    expect(snapshot()).toBe(before);
  });
});
