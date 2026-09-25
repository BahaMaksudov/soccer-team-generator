import { describe, it, expect } from "vitest";
import { buildCanonicalPrintHref } from "./printHref";

describe("buildCanonicalPrintHref", () => {
  it("builds the canonical print URL from org/group/generation slugs+id", () => {
    expect(buildCanonicalPrintHref("new-england-eagles", "indoor-soccer", "gen-a")).toBe(
      "/g/new-england-eagles/indoor-soccer/print/gen-a"
    );
  });

  it("never produces a legacy /print/... link, regardless of input", () => {
    const href = buildCanonicalPrintHref("new-england-eagles", "indoor-soccer", "gen-a");
    expect(href.startsWith("/print/")).toBe(false);
    expect(href.startsWith("/g/")).toBe(true);
  });

  it("Org A and Org B (same group slug) produce distinct, tenant-correct links", () => {
    const a = buildCanonicalPrintHref("org-a", "indoor-soccer", "gen-a");
    const b = buildCanonicalPrintHref("org-b", "indoor-soccer", "gen-b");

    expect(a).toBe("/g/org-a/indoor-soccer/print/gen-a");
    expect(b).toBe("/g/org-b/indoor-soccer/print/gen-b");
    expect(a).not.toBe(b);
  });
});
