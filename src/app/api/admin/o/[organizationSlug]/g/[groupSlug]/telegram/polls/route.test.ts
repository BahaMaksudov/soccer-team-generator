import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockPollFindMany = vi.fn();
const mockPollUpsert = vi.fn();
const mockPollUpdateMany = vi.fn();
const mockChatFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPoll: {
      findMany: (...args: unknown[]) => mockPollFindMany(...args),
      upsert: (...args: unknown[]) => mockPollUpsert(...args),
      updateMany: (...args: unknown[]) => mockPollUpdateMany(...args),
    },
    telegramChat: {
      findMany: (...args: unknown[]) => mockChatFindMany(...args),
    },
  },
}));

import { GET } from "./route";
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

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

function reqWithQuery(query = "") {
  return new Request(`http://localhost${query}`);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPollFindMany.mockResolvedValue([]);
  mockChatFindMany.mockResolvedValue([]);
  fetchSpy = vi.spyOn(global, "fetch");
});

describe("GET canonical telegram/polls — read isolation", () => {
  it("scopes the poll query to the URL-resolved Group alongside the existing isClosed filter", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));

    const call = mockPollFindMany.mock.calls[0][0];
    expect(call.where).toEqual({ groupId: "group-a", isClosed: false });
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("includeClosed=1 keeps the groupId filter while dropping the isClosed filter", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery("?includeClosed=1"), ctx("org-a", "group-a"));

    const call = mockPollFindMany.mock.calls[0][0];
    expect(call.where).toEqual({ groupId: "group-a" });
  });

  it("chat-title enrichment is derived only from already-scoped poll results, never independently queried by tenant", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockPollFindMany.mockResolvedValue([
      { pollId: "p1", chatId: 111n, question: "Q", pollDate: null, isClosed: false, createdAt: new Date("2026-01-01") },
    ]);
    mockChatFindMany.mockResolvedValue([{ chatId: 111n, title: "Group A Chat" }]);

    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(json.polls[0].chatTitle).toBe("Group A Chat");
    const chatCall = mockChatFindMany.mock.calls[0][0];
    expect(chatCall.where.chatId.in).toEqual([111n]);
  });

  it("Group A and Group B requests never collide", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const callA = mockPollFindMany.mock.calls[0][0];

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    await GET(reqWithQuery(), ctx("org-b", "group-b"));
    const callB = mockPollFindMany.mock.calls[1][0];

    expect(callA.where.groupId).toBe("group-a");
    expect(callB.where.groupId).toBe("group-b");
  });

  it("same Group slug across different Organizations remains isolated", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    await GET(reqWithQuery(), ctx("org-a", "indoor-soccer"));
    expect(mockPollFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId: "group-a", isClosed: false } })
    );

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    await GET(reqWithQuery(), ctx("org-b", "indoor-soccer"));
    expect(mockPollFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId: "group-b", isClosed: false } })
    );
  });

  it("a query-string groupId/organizationId cannot influence tenancy", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery("?groupId=group-b&organizationId=org-b"), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockPollFindMany.mock.calls[0][0].where.groupId).toBe("group-a");
  });

  it("unknown Organization fails closed before any TelegramPoll read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await GET(reqWithQuery(), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockPollFindMany).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group fails closed before any TelegramPoll read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await GET(reqWithQuery(), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockPollFindMany).not.toHaveBeenCalled();
  });

  it("unknown Organization and foreign Group produce the identical status + body (no existence leak)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await GET(reqWithQuery(), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await GET(reqWithQuery(), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });

  it("propagates UNAUTHENTICATED as 401 without ever querying TelegramPoll", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockPollFindMany).not.toHaveBeenCalled();
  });
});

describe("GET canonical telegram/polls — side-effect prohibition", () => {
  it("never calls the Telegram Bot API (no fetch)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never mutates TelegramPoll", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(mockPollUpsert).not.toHaveBeenCalled();
    expect(mockPollUpdateMany).not.toHaveBeenCalled();
  });
});
