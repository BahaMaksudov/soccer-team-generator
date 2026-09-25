import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOrgFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: (...args: unknown[]) => mockOrgFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
  },
}));

import { loadPublicGroupLayoutData } from "./layout-data";

const ORG_A = { id: "org-a", name: "New England Eagles", slug: "new-england-eagles" };
const GROUP_A = {
  id: "group-a",
  name: "Indoor Soccer A",
  slug: "indoor-soccer",
  sportKey: "soccer",
  timezone: "America/New_York",
  isActive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadPublicGroupLayoutData", () => {
  it("resolves a valid Group", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(GROUP_A);

    const data = await loadPublicGroupLayoutData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });

    expect(data?.publicGroup.group.id).toBe("group-a");
  });

  it("returns null for an unknown organization", async () => {
    mockOrgFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupLayoutData({
      organizationSlug: "does-not-exist",
      groupSlug: "indoor-soccer",
    });

    expect(data).toBeNull();
  });

  it("returns null for an unknown/mismatched group", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue(null);

    const data = await loadPublicGroupLayoutData({
      organizationSlug: "new-england-eagles",
      groupSlug: "belongs-to-another-org",
    });

    expect(data).toBeNull();
  });

  it("returns null for an inactive group", async () => {
    mockOrgFindUnique.mockResolvedValue(ORG_A);
    mockGroupFindUnique.mockResolvedValue({ ...GROUP_A, isActive: false });

    const data = await loadPublicGroupLayoutData({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });

    expect(data).toBeNull();
  });
});
