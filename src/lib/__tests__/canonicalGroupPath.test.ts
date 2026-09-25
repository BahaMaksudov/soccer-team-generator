import { describe, it, expect } from "vitest";
import { parseCanonicalGroupPath } from "../canonicalGroupPath";

describe("parseCanonicalGroupPath", () => {
  it("parses the canonical Group home path", () => {
    expect(parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer")).toEqual({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });
  });

  it("parses the canonical Players path (nested below the group segment)", () => {
    expect(parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer/players")).toEqual({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });
  });

  it("parses the canonical Print path (Phase 2D.5E — nested two levels below the group segment)", () => {
    expect(
      parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer/print/cmjxikf640005jo047roibr7m")
    ).toEqual({
      organizationSlug: "new-england-eagles",
      groupSlug: "indoor-soccer",
    });
  });

  it("resolves the SAME organizationSlug/groupSlug for home, players, and print under one group", () => {
    const home = parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer");
    const players = parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer/players");
    const print = parseCanonicalGroupPath("/g/new-england-eagles/indoor-soccer/print/gen-1");

    expect(home).toEqual(players);
    expect(players).toEqual(print);
  });

  it("returns null for legacy home", () => {
    expect(parseCanonicalGroupPath("/")).toBeNull();
  });

  it("returns null for legacy players", () => {
    expect(parseCanonicalGroupPath("/players")).toBeNull();
  });

  it("returns null for admin/login", () => {
    expect(parseCanonicalGroupPath("/admin")).toBeNull();
    expect(parseCanonicalGroupPath("/login")).toBeNull();
  });

  it("returns null for /g with no segments, or only one segment", () => {
    expect(parseCanonicalGroupPath("/g")).toBeNull();
    expect(parseCanonicalGroupPath("/g/")).toBeNull();
    expect(parseCanonicalGroupPath("/g/only-org-slug")).toBeNull();
  });

  it("returns null for null/undefined pathname", () => {
    expect(parseCanonicalGroupPath(null)).toBeNull();
    expect(parseCanonicalGroupPath(undefined)).toBeNull();
  });

  it("Org A and Org B resolve to distinct results even with the same group slug", () => {
    const a = parseCanonicalGroupPath("/g/org-a/indoor-soccer/players");
    const b = parseCanonicalGroupPath("/g/org-b/indoor-soccer/players");
    expect(a).toEqual({ organizationSlug: "org-a", groupSlug: "indoor-soccer" });
    expect(b).toEqual({ organizationSlug: "org-b", groupSlug: "indoor-soccer" });
    expect(a?.organizationSlug).not.toBe(b?.organizationSlug);
  });
});
