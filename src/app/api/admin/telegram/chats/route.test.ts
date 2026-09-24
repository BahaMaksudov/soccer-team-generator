import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramChat: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
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
});

describe("GET /api/admin/telegram/chats", () => {
  it("scopes the query to the caller's active group", async () => {
    mockFindMany.mockResolvedValue([{ chatId: 111n, title: "Group A Chat" }]);

    const res = await GET();
    expect(res.status).toBe(200);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );

    const data = await res.json();
    expect(data.chats).toEqual([{ chatId: "111", title: "Group A Chat" }]);
  });

  it("a foreign-group chat can never appear regardless of DB contents, because groupId is always the caller's own", async () => {
    mockFindMany.mockResolvedValue([]);
    await GET();
    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.groupId).toBe("group-a");
    expect(call.where.groupId).not.toBe("group-b");
  });

  it("propagates UNAUTHENTICATED without ever querying TelegramChat", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
