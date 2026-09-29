import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2D.6E.3B — the public print page renders a stored UTC-midnight
 * TeamGeneration.date as its exact calendar day regardless of the
 * server's timezone (it is a Server Component, so "local" means the
 * server's TZ — previously correct only when the server ran in UTC).
 */

const mockLoad = vi.fn();
vi.mock("./data", () => ({ loadPublicGroupPrintData: (...a: unknown[]) => mockLoad(...a) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import PublicGroupPrint from "./page";

function withTZ<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  });
}

async function renderPrint(): Promise<string> {
  mockLoad.mockResolvedValue({
    id: "gen-1",
    date: new Date("2026-10-05T00:00:00.000Z"), // exactly how TeamGeneration.date is stored
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    teams: [{ teamNumber: 1, players: [{ id: "p1", firstName: "test", lastName: "one", position: "DEFENDER" }] }],
  });
  const el = await PublicGroupPrint({
    params: Promise.resolve({ organizationSlug: "new-england-eagles", groupSlug: "tenant-isolation-test", generationId: "gen-1" }),
  });
  return renderToStaticMarkup(el);
}

describe("public print page date is timezone-safe", () => {
  for (const tz of ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"]) {
    it(`TZ=${tz}: stored 2026-10-05T00:00:00.000Z prints "Teams for October 5, 2026"`, async () => {
      const html = await withTZ(tz, renderPrint);
      expect(html).toMatch(/Teams for (?:<!-- -->)?October 5, 2026/);
      expect(html).not.toContain("October 4, 2026");
    });
  }

  it("formats the generation date with the shared date-only formatter", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("return formatLongDateOnly(d);");
    expect(src).not.toMatch(/d\.toLocaleDateString\(/);
  });
});
