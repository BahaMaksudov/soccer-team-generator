import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockFindMany = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    telegramChat: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
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
  fetchSpy = vi.spyOn(global, "fetch");
});

describe("GET canonical telegram/chats — read isolation", () => {
  it("reads only the URL-resolved Group's chats", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([{ chatId: 111n, title: "Group A Chat" }]);

    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.chats).toEqual([{ chatId: "111", title: "Group A Chat" }]);
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
  });

  it("a foreign Group's chats never appear — query is structurally scoped to the caller's own activeGroup", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([]);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const call = mockFindMany.mock.calls[0][0];
    expect(call.where.groupId).toBe("group-a");
    expect(call.where.groupId).not.toBe("group-b");
  });

  it("Group A and Group B requests never collide", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([]);
    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    const callA = mockFindMany.mock.calls[0][0];

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockFindMany.mockResolvedValue([]);
    await GET(reqWithQuery(), ctx("org-b", "group-b"));
    const callB = mockFindMany.mock.calls[1][0];

    expect(callA.where.groupId).toBe("group-a");
    expect(callB.where.groupId).toBe("group-b");
  });

  it("same Group slug across different Organizations remains isolated", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    mockFindMany.mockResolvedValue([]);
    await GET(reqWithQuery(), ctx("org-a", "indoor-soccer"));
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-a" } }));

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    mockFindMany.mockResolvedValue([]);
    await GET(reqWithQuery(), ctx("org-b", "indoor-soccer"));
    expect(mockFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { groupId: "group-b" } }));
  });

  it("a query-string groupId/organizationId cannot influence tenancy", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([]);

    await GET(reqWithQuery("?groupId=group-b&organizationId=org-b"), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockFindMany.mock.calls[0][0].where.groupId).toBe("group-a");
  });

  it("unknown Organization fails closed before any TelegramChat read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await GET(reqWithQuery(), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group fails closed before any TelegramChat read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await GET(reqWithQuery(), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
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

  it("propagates UNAUTHENTICATED as 401 without ever querying TelegramChat", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("UNAUTHENTICATED"));
    const res = await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("GET canonical telegram/chats — side-effect prohibition", () => {
  it("never calls the Telegram Bot API (no fetch)", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([]);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never mutates TelegramChat", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockFindMany.mockResolvedValue([]);

    await GET(reqWithQuery(), ctx("org-a", "group-a"));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
