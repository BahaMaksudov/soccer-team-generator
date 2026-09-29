import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import TeamPreview from "./TeamPreview";

/**
 * Phase 2D.6E.3B — regression for the live bug: a preview for
 * 2026-10-05 displayed "October 4, 2026" in America/New_York because the
 * UTC-midnight date was formatted in the browser's local timezone.
 */

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

function shownDate(previewDate: string): string {
  const html = renderToStaticMarkup(
    createElement(TeamPreview, {
      previewDate,
      previewTeams: [
        { teamNumber: 1, players: [{ id: "p1", firstName: "test", lastName: "one", position: "MIDFIELDER" }] },
      ],
    })
  );
  return html.match(/<b>([^<]+)<\/b>/)?.[1] ?? "";
}

describe("TeamPreview date display is timezone-safe", () => {
  for (const tz of ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"]) {
    it(`TZ=${tz}: Generate's UTC-midnight ISO date renders October 5, 2026 (not October 4)`, () => {
      withTZ(tz, () => {
        expect(shownDate("2026-10-05T00:00:00.000Z")).toBe("October 5, 2026");
        expect(shownDate("2026-10-05T00:00:00.000Z")).not.toBe("October 4, 2026");
      });
    });

    it(`TZ=${tz}: a raw YYYY-MM-DD preview date also renders October 5, 2026`, () => {
      withTZ(tz, () => expect(shownDate("2026-10-05")).toBe("October 5, 2026"));
    });
  }

  it("uses the shared date-only formatter, not local-time formatting", () => {
    const src = fs.readFileSync(path.join(__dirname, "TeamPreview.tsx"), "utf8");
    expect(src).toContain("formatLongDateOnly(previewDate)");
    expect(src).not.toMatch(/toLocaleDateString|new Date\(/);
  });

  it("still renders the teams and players unchanged", () => {
    const html = renderToStaticMarkup(
      createElement(TeamPreview, {
        previewDate: "2026-10-05T00:00:00.000Z",
        previewTeams: [
          { teamNumber: 1, players: [{ id: "p1", firstName: "test", lastName: "one", position: "MIDFIELDER" }] },
          { teamNumber: 2, players: [{ id: "p2", firstName: "test", lastName: "two", position: "GOALKEEPER" }] },
        ],
      })
    );
    expect(html).toContain("#1");
    expect(html).toContain("#2");
    expect(html).toContain("test one");
    expect(html).toContain("Midfielder");
    expect(html).toContain("Goalkeeper");
  });
});
