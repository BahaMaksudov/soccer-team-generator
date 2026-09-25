import { describe, it, expect, vi } from "vitest";

const mockPlayerFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { player: { findMany: (...args: unknown[]) => mockPlayerFindMany(...args) } },
}));

import { GET } from "./route";

describe("GET /api/public/players — retired (Phase 2D.5F)", () => {
  it("returns 410 Gone", async () => {
    const res = await GET();
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json).toEqual({ error: "This endpoint has been retired." });
  });

  it("never queries Player", async () => {
    await GET();
    expect(mockPlayerFindMany).not.toHaveBeenCalled();
  });
});
