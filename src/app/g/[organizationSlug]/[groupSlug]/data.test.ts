import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrgFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();
const mockTeamGenerationCount = vi.fn();
const mockTeamGenerationFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: (...args: unknown[]) => mockOrgFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
    teamGeneration: {
      count: (...args: unknown[]) => mockTeamGenerationCount(...args),
      findMany: (...args: unknown[]) => mockTeamGenerationFindMany(...args),
    },
  },
}));

import { loadPublicGroupHomeData } from "./data";

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
  slug: "indoor-soccer", // same slug as GROUP_A, different org — proves org+slug scoping, not slug alone
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

function genFixture(id: string, teamNumber: number, playerName: string) {
  return {
    id,
    date: new Date("2026-09-20T00:00:00.000Z"),
    updatedAt: new Date("2026-09-20T12:00:00.000Z"),
    teamsJson: JSON.stringify([
      { teamNumber, players: [{ id: `${id}-p1`, firstName: playerName, lastName: "X", position: "MIDFIELDER" }] },
    ]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPublicGroupHomeData — resolver gate", () => {
  it("unknown organization slug -> null, TeamGeneration is never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "does-not-exist",
      groupSlug: "indoor-soccer",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationCount).not.toHaveBeenCalled();
    expect(mockTeamGenerationFindMany).not.toHaveBeenCalled();
  });

  it("a group slug that doesn't exist under the real organization -> null, no data query, no leak of the real owner", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "new-england-eagles",
      groupSlug: "belongs-to-another-org",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationCount).not.toHaveBeenCalled();
    expect(mockTeamGenerationFindMany).not.toHaveBeenCalled();
  });

  it("an inactive group -> null", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue({ ...GROUP_A, isActive: false });

    const data = await loadPublicGroupHomeData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationCount).not.toHaveBeenCalled();
  });
});

describe("loadPublicGroupHomeData — two-group tenant isolation", () => {
  it("scopes both count() and findMany() to the resolved group's id", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationCount.mockResolvedValue(2);
    mockTeamGenerationFindMany.mockResolvedValue([genFixture("a1", 1, "AlicePlayerA")]);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });

    expect(mockTeamGenerationCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
    expect(mockTeamGenerationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" } })
    );
    expect(data?.publicGroup.group.id).toBe("group-a");
    expect(data?.items[0].teams[0].players[0].firstName).toBe("AlicePlayerA");
  });

  it("resolves the correct Group (org-a) even when a same-slug Group exists under a different organization (org-b)", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationCount.mockResolvedValue(1);
    mockTeamGenerationFindMany.mockResolvedValue([genFixture("a1", 1, "AlicePlayerA")]);

    await loadPublicGroupHomeData({ organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" });

    expect(mockGroupFindUnique).toHaveBeenCalledWith({
      where: { organizationId_slug: { organizationId: "org-a", slug: "indoor-soccer" } },
    });
  });

  it("Group B's request (same group slug, different org) resolves independently and never touches Group A's id", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_B);
    mockGroupFindUnique.mockResolvedValue(GROUP_B);
    mockTeamGenerationCount.mockResolvedValue(1);
    mockTeamGenerationFindMany.mockResolvedValue([genFixture("b1", 1, "BobPlayerB")]);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "boston-rovers",
      groupSlug: "indoor-soccer",
    });

    expect(mockGroupFindUnique).toHaveBeenCalledWith({
      where: { organizationId_slug: { organizationId: "org-b", slug: "indoor-soccer" } },
    });
    expect(mockTeamGenerationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-b" } })
    );
    expect(data?.publicGroup.group.id).toBe("group-b");
    expect(data?.items[0].teams[0].players[0].firstName).toBe("BobPlayerB");
  });

  it("pagination totalPages reflects only the resolved group's own count, not a global count", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationCount.mockResolvedValue(2); // Group A has 2, regardless of what Group B has
    mockTeamGenerationFindMany.mockResolvedValue([genFixture("a1", 1, "AlicePlayerA")]);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });

    // pageSize=4, total=2 -> totalPages=1
    expect(data?.totalPages).toBe(1);
  });

  it("honors the requested page while keeping the query scoped to the resolved group", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationCount.mockResolvedValue(10);
    mockTeamGenerationFindMany.mockResolvedValue([]);

    const data = await loadPublicGroupHomeData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      page: "2",
    });

    expect(data?.page).toBe(2);
    expect(mockTeamGenerationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: "group-a" }, skip: 4, take: 4 })
    );
  });
});
