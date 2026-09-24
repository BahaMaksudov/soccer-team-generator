import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
});

const mockPollFindMany = vi.fn();
const mockChatFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPoll: { findMany: (...args: unknown[]) => mockPollFindMany(...args) },
    telegramChat: { findMany: (...args: unknown[]) => mockChatFindMany(...args) },
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

function req(url: string) {
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
  mockPollFindMany.mockResolvedValue([]);
  mockChatFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/telegram/polls", () => {
  it("scopes the poll query to the caller's active group alongside the existing isClosed filter", async () => {
    await GET(req("http://localhost/api/admin/telegram/polls"));

    const call = mockPollFindMany.mock.calls[0][0];
    expect(call.where).toEqual({ groupId: "group-a", isClosed: false });
  });

  it("includeClosed=1 keeps the groupId filter while dropping the isClosed filter", async () => {
    await GET(req("http://localhost/api/admin/telegram/polls?includeClosed=1"));

    const call = mockPollFindMany.mock.calls[0][0];
    expect(call.where).toEqual({ groupId: "group-a" });
  });

  it("a different active group produces a structurally different selector — no cross-tenant bleed", async () => {
    await GET(req("http://localhost/api/admin/telegram/polls"));
    const callA = mockPollFindMany.mock.calls[0][0];

    vi.clearAllMocks();
    const GROUP_B = { id: "group-b", name: "B", slug: "b", sportKey: "soccer", timezone: "America/New_York" };
    mockRequireTenantContext.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_B });
    mockPollFindMany.mockResolvedValue([]);
    mockChatFindMany.mockResolvedValue([]);
    await GET(req("http://localhost/api/admin/telegram/polls"));
    const callB = mockPollFindMany.mock.calls[0][0];

    expect(callA.where.groupId).toBe("group-a");
    expect(callB.where.groupId).toBe("group-b");
  });

  it("propagates UNAUTHENTICATED without ever querying TelegramPoll", async () => {
    mockRequireTenantContext.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET(req("http://localhost/api/admin/telegram/polls"));
    expect(res.status).toBe(401);
    expect(mockPollFindMany).not.toHaveBeenCalled();
  });
});
