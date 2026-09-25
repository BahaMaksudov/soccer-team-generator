import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrgFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();
const mockGroupSettingFindUnique = vi.fn();
const mockAppSettingFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: (...args: unknown[]) => mockOrgFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
    groupSetting: { findUnique: (...args: unknown[]) => mockGroupSettingFindUnique(...args) },
    appSetting: { findUnique: (...args: unknown[]) => mockAppSettingFindUnique(...args) },
  },
}));

import { GET } from "./route";

const ORG_A = { id: "org-a", name: "New England Eagles", slug: "new-england-eagles" };
const GROUP_A = {
  id: "group-a",
  name: "Indoor Soccer A",
  slug: "indoor-soccer",
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

const ORG_B = { id: "org-b", name: "Boston Rovers", slug: "boston-rovers" };
const GROUP_B = {
  id: "group-b",
  name: "Rovers Indoor",
  slug: "indoor-soccer",
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

function ctx(organizationSlug: string, groupSlug: string) {
  return { params: Promise.resolve({ organizationSlug, groupSlug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/team-name — resolver gate", () => {
  it("unknown organization -> 404, GroupSetting never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("does-not-exist", "indoor-soccer"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("unknown/mismatched group -> 404, GroupSetting never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "belongs-to-org-b"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });

  it("inactive group -> 404, GroupSetting never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue({ ...GROUP_A, isActive: false });

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    expect(res.status).toBe(404);
    expect(mockGroupSettingFindUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/team-name — tenant isolation", () => {
  it("Group A reads only Group A's teamName via the groupId_key selector", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Team A" });

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    const json = await res.json();

    expect(json.teamName).toBe("Team A");
    expect(mockGroupSettingFindUnique).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-a", key: "teamName" } },
    });
  });

  it("Group B (same group slug, different org) resolves and reads independently", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_B);
    mockGroupFindUnique.mockResolvedValue(GROUP_B);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Team B" });

    const res = await GET(new Request("http://localhost"), ctx("boston-rovers", "indoor-soccer"));
    const json = await res.json();

    expect(json.teamName).toBe("Team B");
    expect(mockGroupSettingFindUnique).toHaveBeenCalledWith({
      where: { groupId_key: { groupId: "group-b", key: "teamName" } },
    });
  });

  it("a client-supplied groupId query param has no effect on the resolved target", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Team A" });

    await GET(
      new Request("http://localhost/api/public/new-england-eagles/indoor-soccer/team-name?groupId=group-b"),
      ctx("new-england-eagles", "indoor-soccer")
    );

    const call = mockGroupSettingFindUnique.mock.calls[0][0];
    expect(call.where.groupId_key.groupId).toBe("group-a");
  });
});

describe("GET /api/public/[organizationSlug]/[groupSlug]/team-name — missing/fallback policy", () => {
  it("missing GroupSetting returns an empty teamName, never queries AppSetting", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockGroupSettingFindUnique.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));
    const json = await res.json();

    expect(json.teamName).toBe("");
    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });

  it("never queries AppSetting even on a successful resolution with a real value", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockGroupSettingFindUnique.mockResolvedValue({ value: "Team A" });

    await GET(new Request("http://localhost"), ctx("new-england-eagles", "indoor-soccer"));

    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });
});
