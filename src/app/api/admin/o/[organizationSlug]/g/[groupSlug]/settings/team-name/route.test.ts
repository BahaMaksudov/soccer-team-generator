import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

const mockGroupSettingFindUnique = vi.fn();
const mockGroupSettingUpsert = vi.fn();
const mockAppSettingFindUnique = vi.fn();
const mockAppSettingUpsert = vi.fn();
const mockAppSettingUpdate = vi.fn();
const mockAppSettingCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupSetting: {
      findUnique: (...args: unknown[]) => mockGroupSettingFindUnique(...args),
      upsert: (...args: unknown[]) => mockGroupSettingUpsert(...args),
    },
    appSetting: {
      findUnique: (...args: unknown[]) => mockAppSettingFindUnique(...args),
      upsert: (...args: unknown[]) => mockAppSettingUpsert(...args),
      update: (...args: unknown[]) => mockAppSettingUpdate(...args),
      create: (...args: unknown[]) => mockAppSettingCreate(...args),
    },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { GET, POST, PUT } from "./route";
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

function req(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET canonical team-name — read isolation", () => {
  it("reads only the URL-resolved Group's teamName", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Eagles A" });

    const res = await GET(new Request("http://localhost"), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.teamName).toBe("Eagles A");
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockGroupSettingFindUnique).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "teamName" } },
    });
  });

  it("Group A's request never reads Group B's value", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Eagles A" });
    await GET(new Request("http://localhost"), ctx("org-a", "group-a"));

    expect(mockGroupSettingFindUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId_key: { groupId: "group-b", key: "teamName" } } })
    );
  });

  it("missing GroupSetting returns empty teamName, no AppSetting fallback", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(json.teamName).toBe("");
    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });

  it("unknown Organization fails closed before any GroupSetting read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));

    const res = await GET(new Request("http://localhost"), ctx("not-real", "group-a"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("foreign/unknown Group fails closed before any GroupSetting read", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await GET(new Request("http://localhost"), ctx("org-a", "group-b"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("unknown Organization and foreign Group produce the identical status + body (no existence leak)", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const unknownOrgRes = await GET(new Request("http://localhost"), ctx("not-real", "group-a"));
    const unknownOrgJson = await unknownOrgRes.json();

    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const foreignGroupRes = await GET(new Request("http://localhost"), ctx("org-a", "group-b"));
    const foreignGroupJson = await foreignGroupRes.json();

    expect(unknownOrgRes.status).toBe(foreignGroupRes.status);
    expect(unknownOrgJson).toEqual(foreignGroupJson);
  });
});

describe("POST/PUT canonical team-name — write isolation", () => {
  it("updates only the URL-resolved Group's GroupSetting", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    const res = await POST(req({ teamName: "New Eagles Name" }), ctx("org-a", "group-a"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.teamName).toBe("New Eagles Name");
    expect(mockGroupSettingUpsert).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "teamName" } },
      update: { value: "New Eagles Name" },
      create: { groupId: "group-a", key: "teamName", value: "New Eagles Name" },
    });
  });

  it("PUT behaves identically to POST", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    const res = await PUT(req({ teamName: "Via Put" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(200);
    expect(mockGroupSettingUpsert.mock.calls[0][0].create.groupId).toBe("group-a");
  });

  it("a body groupId cannot redirect the write target", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    await POST(req({ teamName: "Attacker Name", groupId: "group-b" }), ctx("org-a", "group-a"));

    const call = mockGroupSettingUpsert.mock.calls[0][0];
    expect(call.where.groupId_key.groupId).toBe("group-a");
    expect(call.create.groupId).toBe("group-a");
    expect(JSON.stringify(call)).not.toContain("group-b");
  });

  it("a body organizationId cannot redirect tenant resolution", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    await POST(req({ teamName: "Attacker Name", organizationId: "org-b" }), ctx("org-a", "group-a"));

    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
    expect(mockGroupSettingUpsert.mock.calls[0][0].create.groupId).toBe("group-a");
  });

  it("Group A and Group B writes never collide — same key, different Groups", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "A's Name" }), ctx("org-a", "group-a"));
    const callA = mockGroupSettingUpsert.mock.calls[0][0];

    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_B);
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "B's Name" }), ctx("org-b", "group-b"));
    const callB = mockGroupSettingUpsert.mock.calls[1][0];

    expect(callA.where.groupId_key.groupId).toBe("group-a");
    expect(callB.where.groupId_key.groupId).toBe("group-b");
  });

  it("same Group slug across different Organizations remains isolated", async () => {
    const GROUP_A_SAME_SLUG = { ...GROUP_A, slug: "indoor-soccer" };
    const GROUP_B_SAME_SLUG = { ...GROUP_B, slug: "indoor-soccer" };

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_A, activeGroup: GROUP_A_SAME_SLUG });
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "A's Name" }), ctx("org-a", "indoor-soccer"));
    expect(mockGroupSettingUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId_key: { groupId: "group-a", key: "teamName" } } })
    );

    mockRequireTenantContextForSlugs.mockResolvedValue({ ...CONTEXT_B, activeGroup: GROUP_B_SAME_SLUG });
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "B's Name" }), ctx("org-b", "indoor-soccer"));
    expect(mockGroupSettingUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { groupId_key: { groupId: "group-b", key: "teamName" } } })
    );
  });

  it("never calls prisma.appSetting.update/upsert/create", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    await POST(req({ teamName: "New Eagles Name" }), ctx("org-a", "group-a"));

    expect(mockAppSettingUpdate).not.toHaveBeenCalled();
    expect(mockAppSettingUpsert).not.toHaveBeenCalled();
    expect(mockAppSettingCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid teamName before touching Prisma", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    const res = await POST(req({ teamName: "" }), ctx("org-a", "group-a"));
    expect(res.status).toBe(400);
    expect(mockGroupSettingUpsert).not.toHaveBeenCalled();
  });

  it("invalid tenant fails closed before any GroupSetting write", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));

    const res = await POST(req({ teamName: "X" }), ctx("org-a", "not-real-group"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingUpsert).not.toHaveBeenCalled();
  });
});
