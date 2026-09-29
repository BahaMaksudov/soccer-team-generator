import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockAnswerFindMany = vi.fn();
const mockLinkFindMany = vi.fn();
const mockLinkUpsert = vi.fn();
const mockLinkDelete = vi.fn();
const mockPlayerUpdate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramPollAnswer: {
      findMany: (...args: unknown[]) => mockAnswerFindMany(...args),
    },
    telegramUserLink: {
      findMany: (...args: unknown[]) => mockLinkFindMany(...args),
      upsert: (...args: unknown[]) => mockLinkUpsert(...args),
      delete: (...args: unknown[]) => mockLinkDelete(...args),
    },
    player: {
      update: (...args: unknown[]) => mockPlayerUpdate(...args),
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
  mockAnswerFindMany.mockResolvedValue([]);
  mockLinkFindMany.mockResolvedValue([]);
  fetchSpy = vi.spyOn(global, "fetch");
});

describe("GET canonical telegram/users — read isolation", () => {
  it("scopes both the voter query and the linked-user query to the URL-resolved Group", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockAnswerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
    expect(mockLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
  });

  it("a foreign-group voter never appears, because the answer query itself is scoped at the DB layer", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockAnswerFindMany.mockResolvedValue([
      { userId: 1n, username: "a", firstName: "A", lastName: null },
    ]);

    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(json).toEqual([{ userId: "1", username: "a", firstName: "A", lastName: null }]);
    expect(mockAnswerFindMany.mock.calls[0][0].where).toEqual({ groupId: "group-a" });
  });

  it("Group A and Group B requests never collide", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const callA = mockAnswerFindMany.mock.calls[0][0];

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    await GET(reqWithQuery(), ctx("org-b", "group-b"));
    const callB = mockAnswerFindMany.mock.calls[1][0];

    expect(callA.where.groupId).toBe("group-a");
    expect(callB.where.groupId).toBe("group-b");
  });

  it("same Group slug across different Organizations remains isolated", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    await GET(reqWithQuery(), ctx("org-a", "indoor-soccer"));
    expect(mockAnswerFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-a" } }));

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    await GET(reqWithQuery(), ctx("org-b", "indoor-soccer"));
    expect(mockAnswerFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-b" } }));
  });

  it("a query-string groupId/organizationId cannot influence tenancy", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery("?groupId=group-b&organizationId=org-b"), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockAnswerFindMany.mock.calls[0][0].where.groupId).toBe("group-a");
  });

  it("unknown Organization fails closed before any Telegram data read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await GET(reqWithQuery(), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
    expect(mockLinkFindMany).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group fails closed before any Telegram data read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await GET(reqWithQuery(), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
    expect(mockLinkFindMany).not.toHaveBeenCalled();
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

  it("propagates UNAUTHENTICATED as 401 without querying either model", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockAnswerFindMany).not.toHaveBeenCalled();
    expect(mockLinkFindMany).not.toHaveBeenCalled();
  });
});

describe("GET canonical telegram/users — side-effect prohibition", () => {
  it("never calls the Telegram Bot API (no fetch)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never mutates TelegramUserLink or Player", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(mockLinkUpsert).not.toHaveBeenCalled();
    expect(mockLinkDelete).not.toHaveBeenCalled();
    expect(mockPlayerUpdate).not.toHaveBeenCalled();
  });
});
