import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2D.2b: publish now uses a single atomic Prisma upsert keyed by
 * the compound (groupId, date) unique constraint added in
 * prisma/migrations/20260924214047_phase_2d_2b_team_generation_group_date_unique.
 * These tests assert the actual shipped route calls `upsert` with the
 * correct selector/data shape — not a reimplementation of it.
 */

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockUpsert = vi.fn();
const mockDeleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamGeneration: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    // Not exercised: every test below omits `pollId`, so the route's
    // Telegram branch (`if (pollId && ...)`) never runs — no Telegram
    // API call, no telegramPoll query, exactly as instructed.
    telegramPoll: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST, DELETE } from "./route";

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

const GROUP_B = { id: "group-b", name: "B", slug: "b", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_B = {
  user: { id: "u2", email: "b@example.com", name: null },
  organization: { id: "org-b", name: "Org B", slug: "org-b" },
  membership: { id: "m2", role: "OWNER" as const },
  groups: [GROUP_B],
  activeGroup: GROUP_B,
};

function publishReq(body: unknown) {
  return new Request("http://localhost/api/admin/publish", { method: "POST", body: JSON.stringify(body) });
}

const SAMPLE_TEAMS = [{ teamNumber: 1, players: [{ firstName: "A", lastName: "B" }] }];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
});

describe("POST /api/admin/publish — atomic tenant-aware upsert", () => {
  it("same Group + same date: upsert selector and create payload both use the caller's active group", async () => {
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }));
    expect(res.status).toBe(200);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0][0];

    // The compound selector — proves the upsert can only ever address
    // a row owned by group-a.
    expect(call.where).toEqual({
      groupId_date: { groupId: "group-a", date: expect.any(Date) },
    });
    // Create payload also stamps group-a — never client input.
    expect(call.create).toEqual(
      expect.objectContaining({ groupId: "group-a", teamsJson: expect.any(String) })
    );
    // Update payload never needs to touch groupId — the selector
    // already guarantees the matched row belongs to group-a.
    expect(call.update).not.toHaveProperty("groupId");
  });

  it("different Group + same date is now permitted at the schema level — Group A's selector can never address Group B's row", async () => {
    mockUpsert.mockResolvedValue({ id: "gen-a" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }));
    const callA = mockUpsert.mock.calls[0][0];
    expect(callA.where.groupId_date.groupId).toBe("group-a");

    vi.clearAllMocks();
    mockRequireTenantContext.mockResolvedValue(CONTEXT_B);
    mockUpsert.mockResolvedValue({ id: "gen-b" });
    await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }));
    const callB = mockUpsert.mock.calls[0][0];
    expect(callB.where.groupId_date.groupId).toBe("group-b");

    // Same date, structurally different selectors — Prisma's compound
    // unique index means these can never collide or address each
    // other's row, which is exactly what the migration exists to allow.
    expect(callA.where.groupId_date.groupId).not.toBe(callB.where.groupId_date.groupId);
  });

  it("a client-supplied groupId in the request body cannot influence the selector or the create payload", async () => {
    mockUpsert.mockResolvedValue({ id: "gen-1" });

    // publishTeamsSchema has no `groupId` field, so this is stripped by
    // Zod before parsed.data even exists — this test proves the value
    // never reaches Prisma regardless.
    const res = await POST(
      publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS, groupId: "group-b" })
    );
    expect(res.status).toBe(200);

    const call = mockUpsert.mock.calls[0][0];
    expect(call.where.groupId_date.groupId).toBe("group-a");
    expect(call.create.groupId).toBe("group-a");
  });

  it("propagates UNAUTHENTICATED without ever touching TeamGeneration", async () => {
    const { TenantContextError } = await import("@/lib/tenantContext");
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));

    const res = await POST(publishReq({ date: "2026-09-28", teams: SAMPLE_TEAMS }));
    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/publish — cross-tenant delete protection", () => {
  it("scopes deleteMany to both the date range AND the caller's active group", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });

    const res = await DELETE(new Request("http://localhost/api/admin/publish?date=2026-09-28"));
    expect(res.status).toBe(200);

    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupId: "group-a" }),
      })
    );
  });

  it("a stale/foreign date range deletes zero rows rather than another group's generation (deleteMany's own where already excludes it)", async () => {
    // Simulates: the only row for this date belongs to group-b, so the
    // groupId-scoped deleteMany naturally matches nothing.
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const res = await DELETE(new Request("http://localhost/api/admin/publish?date=2026-09-28"));
    const data = await res.json();
    expect(data.deleted).toBe(0);
  });
});
