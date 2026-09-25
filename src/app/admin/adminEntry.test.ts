import { describe, it, expect } from "vitest";
import { resolveAdminEntry } from "./adminEntry";
import type { AccessibleOrganization } from "@/lib/tenantContext";

function org(overrides: Partial<AccessibleOrganization> = {}): AccessibleOrganization {
  return {
    id: "org-1",
    name: "New England Eagles",
    slug: "new-england-eagles",
    role: "OWNER",
    groups: [
      { id: "group-1", name: "Indoor Soccer", slug: "indoor-soccer", sportKey: "soccer", timezone: "America/New_York" },
    ],
    ...overrides,
  };
}

describe("resolveAdminEntry", () => {
  it("one org + one active group -> canonical redirect", () => {
    const result = resolveAdminEntry([org()]);
    expect(result).toEqual({ kind: "redirect", href: "/admin/o/new-england-eagles/g/indoor-soccer" });
  });

  it("one org + multiple active groups -> selector, never auto-picks [0]", () => {
    const multiGroupOrg = org({
      groups: [
        { id: "g1", name: "Soccer", slug: "soccer", sportKey: "soccer", timezone: "America/New_York" },
        { id: "g2", name: "Basketball", slug: "basketball", sportKey: "basketball", timezone: "America/New_York" },
      ],
    });
    const result = resolveAdminEntry([multiGroupOrg]);
    expect(result.kind).toBe("select");
    if (result.kind === "select") {
      expect(result.organizations).toEqual([multiGroupOrg]);
    }
  });

  it("multiple orgs -> selector, never auto-picks an organization", () => {
    const orgs = [org({ id: "org-a", slug: "org-a" }), org({ id: "org-b", slug: "org-b" })];
    const result = resolveAdminEntry(orgs);
    expect(result).toEqual({ kind: "select", organizations: orgs });
  });

  it("zero memberships -> no-access", () => {
    const result = resolveAdminEntry([]);
    expect(result).toEqual({ kind: "no-access" });
  });

  it("one org + zero active groups -> no-active-groups", () => {
    const emptyOrg = org({ groups: [] });
    const result = resolveAdminEntry([emptyOrg]);
    expect(result).toEqual({ kind: "no-active-groups", organization: emptyOrg });
  });

  it("multiple orgs where only ONE has active groups -> still selector, never arbitrarily chosen", () => {
    const withGroups = org({ id: "org-a", slug: "org-a" });
    const withoutGroups = org({ id: "org-b", slug: "org-b", groups: [] });
    const result = resolveAdminEntry([withGroups, withoutGroups]);
    expect(result.kind).toBe("select");
    if (result.kind === "select") {
      expect(result.organizations).toHaveLength(2);
    }
  });

  it("URL-encodes slugs when constructing the redirect href", () => {
    const weirdOrg = org({
      slug: "org with space",
      groups: [{ id: "g1", name: "G", slug: "group/slash", sportKey: "soccer", timezone: "America/New_York" }],
    });
    const result = resolveAdminEntry([weirdOrg]);
    expect(result).toEqual({ kind: "redirect", href: `/admin/o/${encodeURIComponent("org with space")}/g/${encodeURIComponent("group/slash")}` });
  });

  it("never references DEFAULT_PUBLIC_ORGANIZATION_SLUG/DEFAULT_PUBLIC_GROUP_SLUG in its source", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("./adminEntry.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DEFAULT_PUBLIC_ORGANIZATION_SLUG/);
    expect(source).not.toMatch(/DEFAULT_PUBLIC_GROUP_SLUG/);
  });

  it("the redirect href never contains a raw database id — only slugs", () => {
    const result = resolveAdminEntry([org()]);
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") {
      expect(result.href).not.toContain("org-1");
      expect(result.href).not.toContain("group-1");
    }
  });
});
