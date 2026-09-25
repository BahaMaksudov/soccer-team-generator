import { describe, it, expect, vi } from "vitest";

const mockTeamGenerationFindMany = vi.fn();
const mockTeamGenerationCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamGeneration: {
      findMany: (...args: unknown[]) => mockTeamGenerationFindMany(...args),
      count: (...args: unknown[]) => mockTeamGenerationCount(...args),
    },
  },
}));

import { GET } from "./route";

describe("GET /api/public/team-generations — retired (Phase 2D.5F)", () => {
  it("returns 410 Gone", async () => {
    const res = await GET();
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json).toEqual({ error: "This endpoint has been retired." });
  });

  it("never queries TeamGeneration", async () => {
    await GET();
    expect(mockTeamGenerationFindMany).not.toHaveBeenCalled();
    expect(mockTeamGenerationCount).not.toHaveBeenCalled();
  });
});
