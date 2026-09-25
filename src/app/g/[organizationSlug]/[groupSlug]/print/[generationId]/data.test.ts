import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrgFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();
const mockTeamGenerationFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: (...args: unknown[]) => mockOrgFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
    teamGeneration: { findFirst: (...args: unknown[]) => mockTeamGenerationFindFirst(...args) },
  },
}));

import { loadPublicGroupPrintData } from "./data";

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
  slug: "indoor-soccer", // same slug as GROUP_A, different org
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

function genRow(id: string) {
  return {
    id,
    date: new Date("2026-09-20T00:00:00.000Z"),
    updatedAt: new Date("2026-09-20T12:00:00.000Z"),
    teamsJson: JSON.stringify([{ teamNumber: 1, players: [{ id: "p1", firstName: "A", lastName: "B", position: "MIDFIELDER" }] }]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPublicGroupPrintData — Group resolution", () => {
  it("unknown organization -> null, TeamGeneration never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupPrintData({
      organizationSlug: "does-not-exist",
      groupSlug: "indoor-soccer",
      generationId: "gen-a",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationFindFirst).not.toHaveBeenCalled();
  });

  it("unknown/mismatched group -> null, TeamGeneration never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "belongs-to-org-b",
      generationId: "gen-a",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationFindFirst).not.toHaveBeenCalled();
  });

  it("inactive group -> null, TeamGeneration never queried", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue({ ...GROUP_A, isActive: false });

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      generationId: "gen-a",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationFindFirst).not.toHaveBeenCalled();
  });
});

describe("loadPublicGroupPrintData — generation ownership", () => {
  it("Group A + its own generation succeeds, query constrained by BOTH id and groupId", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationFindFirst.mockResolvedValue(genRow("gen-a"));

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      generationId: "gen-a",
    });

    expect(data?.id).toBe("gen-a");
    expect(mockTeamGenerationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gen-a", groupId: "group-a" } })
    );
  });

  it("Group A + a foreign (Group B's) generation id -> null (simulates the scoped query returning nothing)", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    // The where clause is { id: "gen-b", groupId: "group-a" } — a real
    // DB would return no row since gen-b actually belongs to group-b.
    mockTeamGenerationFindFirst.mockResolvedValue(null);

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      generationId: "gen-b",
    });

    expect(data).toBeNull();
    expect(mockTeamGenerationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gen-b", groupId: "group-a" } })
    );
  });

  it("Group B + its own generation succeeds independently of Group A", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_B);
    mockGroupFindUnique.mockResolvedValue(GROUP_B);
    mockTeamGenerationFindFirst.mockResolvedValue(genRow("gen-b"));

    const data = await loadPublicGroupPrintData({
      organizationSlug: "boston-rovers",
      groupSlug: "indoor-soccer",
      generationId: "gen-b",
    });

    expect(data?.id).toBe("gen-b");
    expect(mockTeamGenerationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gen-b", groupId: "group-b" } })
    );
  });

  it("nonexistent generation -> null, same shape as a foreign generation (no existence leak)", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationFindFirst.mockResolvedValue(null);

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      generationId: "totally-made-up-id",
    });

    expect(data).toBeNull();
  });
});

describe("loadPublicGroupPrintData — DTO", () => {
  it("returned data never includes groupId", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);
    mockTeamGenerationFindFirst.mockResolvedValue(genRow("gen-a"));

    const data = await loadPublicGroupPrintData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
      generationId: "gen-a",
    });

    expect(data).not.toHaveProperty("groupId");
    expect(Object.keys(data ?? {}).sort()).toEqual(["date", "id", "teams", "updatedAt"]);

    // Also assert the Prisma select itself never requests groupId.
    const call = mockTeamGenerationFindFirst.mock.calls[0][0];
    expect(call.select.groupId).toBeUndefined();
  });
});
