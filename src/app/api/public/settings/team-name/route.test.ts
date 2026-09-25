import { describe, it, expect, vi } from "vitest";

const mockAppSettingFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { appSetting: { findUnique: (...args: unknown[]) => mockAppSettingFindUnique(...args) } },
}));

import { GET } from "./route";

describe("GET /api/public/settings/team-name — retired (Phase 2D.5F)", () => {
  it("returns 410 Gone", async () => {
    const res = await GET();
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json).toEqual({ error: "This endpoint has been retired." });
  });

  it("never queries AppSetting", async () => {
    await GET();
    expect(mockAppSettingFindUnique).not.toHaveBeenCalled();
  });
});
