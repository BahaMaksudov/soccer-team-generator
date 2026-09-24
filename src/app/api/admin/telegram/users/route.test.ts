import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockAnswerFindMany = vi.fn();
const mockLinkFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPollAnswer: { findMany: (...args: unknown[]) => mockAnswerFindMany(...args) },
    telegramUserLink: { findMany: (...args: unknown[]) => mockLinkFindMany(...args) },
  },
}));

import { GET } from "./route";
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
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
  mockAnswerFindMany.mockResolvedValue([]);
  mockLinkFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/telegram/users", () => {
  it("scopes both the poll-answer voter query and the linked-user query to the caller's active group", async () => {
    await GET();

    expect(mockAnswerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
    expect(mockLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
  });

  it("a foreign-group voter never appears, because the answer query itself excludes it at the DB layer", async () => {
    // Simulates: the mocked DB already only returns rows matching the
    // where clause, so any group-b voter is invisible by construction.
    mockAnswerFindMany.mockResolvedValue([
      { userId: 1n, username: "a", firstName: "A", lastName: null },
    ]);
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual([
      { userId: "1", username: "a", firstName: "A", lastName: null },
    ]);
    expect(mockAnswerFindMany.mock.calls[0][0].where).toEqual({ groupId: "group-a" });
  });

  it("propagates UNAUTHENTICATED without querying either model", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
    expect(mockLinkFindMany).not.toHaveBeenCalled();
  });
});
