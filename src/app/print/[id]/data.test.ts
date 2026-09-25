import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTeamGenerationFindUnique = vi.fn();
const mockGroupFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamGeneration: { findUnique: (...args: unknown[]) => mockTeamGenerationFindUnique(...args) },
    group: { findUnique: (...args: unknown[]) => mockGroupFindUnique(...args) },
  },
}));

import { resolveLegacyPrintRedirect } from "./data";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveLegacyPrintRedirect — ownership-based redirect destination", () => {
  it("Group A's generation resolves to Group A's canonical slugs", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue({ groupId: "group-a" });
    mockGroupFindUnique.mockResolvedValue({
      slug: "indoor-soccer",
      isActive: true,
      organization: { slug: "new-england-eagles" },
    });

    const dest = await resolveLegacyPrintRedirect("gen-a");

    expect(dest).toEqual({ organizationSlug: "new-england-eagles", groupSlug: "indoor-soccer" });
    expect(mockTeamGenerationFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gen-a" } })
    );
    expect(mockGroupFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "group-a" } })
    );
  });

  it("Group B's generation resolves independently to Group B's canonical slugs (same group slug as Group A, different org)", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue({ groupId: "group-b" });
    mockGroupFindUnique.mockResolvedValue({
      slug: "indoor-soccer",
      isActive: true,
      organization: { slug: "boston-rovers" },
    });

    const dest = await resolveLegacyPrintRedirect("gen-b");

    expect(dest).toEqual({ organizationSlug: "boston-rovers", groupSlug: "indoor-soccer" });
  });

  it("a nonexistent generation -> null", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue(null);

    const dest = await resolveLegacyPrintRedirect("does-not-exist");

    expect(dest).toBeNull();
    expect(mockGroupFindUnique).not.toHaveBeenCalled();
  });

  it("a generation with a null groupId -> null, Group is never queried", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue({ groupId: null });

    const dest = await resolveLegacyPrintRedirect("orphaned-gen");

    expect(dest).toBeNull();
    expect(mockGroupFindUnique).not.toHaveBeenCalled();
  });

  it("a generation whose Group no longer exists -> null", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue({ groupId: "deleted-group" });
    mockGroupFindUnique.mockResolvedValue(null);

    const dest = await resolveLegacyPrintRedirect("gen-x");

    expect(dest).toBeNull();
  });

  it("a generation whose Group is inactive -> null", async () => {
    mockTeamGenerationFindUnique.mockResolvedValue({ groupId: "group-a" });
    mockGroupFindUnique.mockResolvedValue({
      slug: "indoor-soccer",
      isActive: false,
      organization: { slug: "new-england-eagles" },
    });

    const dest = await resolveLegacyPrintRedirect("gen-a");

    expect(dest).toBeNull();
  });
});
