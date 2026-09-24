import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2D.4: GroupSetting is now the sole authoritative source for
 * authenticated Admin team-name reads/writes. These tests prove
 * cross-tenant isolation (Group A never sees/affects Group B), that
 * client-supplied groupId cannot control the write target, that a
 * missing setting returns an empty value rather than any fallback,
 * and that AppSetting is never touched by this route.
 */

const mockRequireTenantContext = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContext: () => mockRequireTenantContext() };
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

const GROUP_A = { id: "group-a", name: "A", slug: "a", sportKey: "soccer", timezone: "America/New_York" };
const GROUP_B = { id: "group-b", name: "B", slug: "b", sportKey: "soccer", timezone: "America/New_York" };

const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [GROUP_A],
  activeGroup: GROUP_A,
};

const CONTEXT_B = {
  user: { id: "u2", email: "b@example.com", name: null },
  organization: { id: "org-b", name: "Org B", slug: "org-b" },
  membership: { id: "m2", role: "OWNER" as const },
  groups: [GROUP_B],
  activeGroup: GROUP_B,
};

function req(body: unknown) {
  return new Request("http://localhost/api/admin/settings/team-name", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/settings/team-name", () => {
  it("returns Group A's teamName, scoped by groupId_key", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Eagles A" });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.teamName).toBe("Eagles A");
    expect(mockGroupSettingFindUnique).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "teamName" } },
    });
  });

  it("never leaks Group B's teamName to Group A — each request resolves its own groupId", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Eagles A" });
    await GET();

    expect(mockGroupSettingFindUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId_key: { groupId: "group-b", key: "teamName" } } })
    );
  });

  it("missing GroupSetting returns an empty teamName — no AppSetting fallback, no cross-tenant fallback", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingFindUnique.mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();

    expect(json.teamName).toBe("");
    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests via the existing tenant-context error mapping", async () => {
    mockRequireTenantContext.mockRejectedValue(
      new TenantContextError("UNAUTHENTICATED", "no session")
    );

    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("fails closed (does not default to a first Group) when tenant context reports multi-group ambiguity", async () => {
    mockRequireTenantContext.mockRejectedValue(
      new TenantContextError("MULTIPLE_GROUPS_REQUIRE_SELECTION", "ambiguous")
    );

    const res = await GET();
    expect(res.status).toBe(409);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });
});

describe("POST/PUT /api/admin/settings/team-name", () => {
  it("updates only Group A's GroupSetting via the compound groupId_key selector", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    const res = await POST(req({ teamName: "New Eagles Name" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.teamName).toBe("New Eagles Name");
    expect(mockGroupSettingUpsert).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "teamName" } },
      update: { value: "New Eagles Name" },
      create: { groupId: "group-a", key: "teamName", value: "New Eagles Name" },
    });
  });

  it("PUT behaves identically to POST (historical dual-method support preserved)", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    const res = await PUT(req({ teamName: "Via Put" }));
    expect(res.status).toBe(200);
    expect(mockGroupSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { groupId: "group-a", key: "teamName", value: "Via Put" } })
    );
  });

  it("a client-supplied groupId in the body cannot control the write target — Group B is never touched", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    await POST(req({ teamName: "Attacker Name", groupId: "group-b" }));

    const call = mockGroupSettingUpsert.mock.calls[0][0];
    expect(call.where.groupId_key.groupId).toBe("group-a");
    expect(call.create.groupId).toBe("group-a");
    expect(JSON.stringify(call)).not.toContain("group-b");
  });

  it("Group A and Group B writes never collide — each stamps its own groupId in the selector", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "A's Name" }));
    const callA = mockGroupSettingUpsert.mock.calls[0][0];

    mockRequireTenantContext.mockResolvedValue(CONTEXT_B);
    mockGroupSettingUpsert.mockResolvedValue({});
    await POST(req({ teamName: "B's Name" }));
    const callB = mockGroupSettingUpsert.mock.calls[1][0];

    expect(callA.where.groupId_key.groupId).toBe("group-a");
    expect(callB.where.groupId_key.groupId).toBe("group-b");
  });

  it("never calls prisma.appSetting.update/upsert/create — GroupSetting is the sole write target", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);
    mockGroupSettingUpsert.mockResolvedValue({});

    await POST(req({ teamName: "New Eagles Name" }));

    expect(mockAppSettingUpdate).not.toHaveBeenCalled();
    expect(mockAppSettingUpsert).not.toHaveBeenCalled();
    expect(mockAppSettingCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty/invalid teamName via the existing Zod schema before touching Prisma", async () => {
    mockRequireTenantContext.mockResolvedValue(CONTEXT_A);

    const res = await POST(req({ teamName: "" }));
    expect(res.status).toBe(400);
    expect(mockGroupSettingUpsert).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated write requests", async () => {
    mockRequireTenantContext.mockRejectedValue(
      new TenantContextError("UNAUTHENTICATED", "no session")
    );

    const res = await POST(req({ teamName: "X" }));
    expect(res.status).toBe(401);
    expect(mockGroupSettingUpsert).not.toHaveBeenCalled();
  });
});
