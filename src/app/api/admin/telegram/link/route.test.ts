import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockPlayerFindFirst = vi.fn();
const mockLinkFindUnique = vi.fn();
const mockLinkUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    player: { findFirst: (...args: unknown[]) => mockPlayerFindFirst(...args) },
    telegramUserLink: {
      findUnique: (...args: unknown[]) => mockLinkFindUnique(...args),
      upsert: (...args: unknown[]) => mockLinkUpsert(...args),
    },
  },
}));

import { POST } from "./route";
import { TenantContextError } from "@/lib/tenantContext";

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

function linkReq(body: unknown) {
  return new Request("http://localhost/api/admin/telegram/link", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
});

describe("POST /api/admin/telegram/link", () => {
  it("cannot link a Telegram user to a foreign-group player — 404, player lookup scoped by groupId", async () => {
    mockPlayerFindFirst.mockResolvedValue(null); // simulates: playerId exists, but belongs to group-b

    const res = await POST(linkReq({ userId: "555", playerId: "player-in-group-b" }));
    expect(res.status).toBe(404);

    expect(mockPlayerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "player-in-group-b", groupId: "group-a" } })
    );
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("cannot silently reassign a Telegram identity already linked under a different group — 409", async () => {
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue({ userId: 555n, playerId: "p-old", groupId: "group-b" });

    const res = await POST(linkReq({ userId: "555", playerId: "p1" }));
    expect(res.status).toBe(409);
    expect(mockLinkUpsert).not.toHaveBeenCalled();
  });

  it("creates a fresh link stamped with the caller's active group", async () => {
    mockPlayerFindFirst.mockResolvedValue({ id: "p1", firstName: "A", lastName: "B" });
    mockLinkFindUnique.mockResolvedValue(null);
    mockLinkUpsert.mockResolvedValue({ userId: 555n, playerId: "p1", groupId: "group-a" });

    const res = await POST(linkReq({ userId: "555", playerId: "p1" }));
    expect(res.status).toBe(200);

    const call = mockLinkUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: 555n });
    expect(call.create).toEqual({ userId: 555n, playerId: "p1", groupId: "group-a" });
    expect(call.update).toEqual({ playerId: "p1", groupId: "group-a" });
  });

  it("re-linking within the SAME group (existing link owned by group-a) is allowed, not rejected", async () => {
    mockPlayerFindFirst.mockResolvedValue({ id: "p2", firstName: "C", lastName: "D" });
    mockLinkFindUnique.mockResolvedValue({ userId: 555n, playerId: "p1", groupId: "group-a" });
    mockLinkUpsert.mockResolvedValue({ userId: 555n, playerId: "p2", groupId: "group-a" });

    const res = await POST(linkReq({ userId: "555", playerId: "p2" }));
    expect(res.status).toBe(200);
    expect(mockLinkUpsert).toHaveBeenCalled();
  });

  it("propagates UNAUTHENTICATED without ever touching Player or TelegramUserLink", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await POST(linkReq({ userId: "555", playerId: "p1" }));
    expect(res.status).toBe(401);
    expect(mockPlayerFindFirst).not.toHaveBeenCalled();
  });
});
