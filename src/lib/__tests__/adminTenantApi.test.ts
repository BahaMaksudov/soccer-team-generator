import { describe, it, expect } from "vitest";
import { adminTenantApiPath } from "../adminTenantApi";

describe("adminTenantApiPath", () => {
  it("builds the canonical admin API path from slugs + a sub-path", () => {
    expect(adminTenantApiPath({ organizationSlug: "org-a", groupSlug: "group-a", path: "/players" })).toBe(
      "/api/admin/o/org-a/g/group-a/players"
    );
  });

  it("normalizes a sub-path without a leading slash", () => {
    expect(adminTenantApiPath({ organizationSlug: "org-a", groupSlug: "group-a", path: "players" })).toBe(
      "/api/admin/o/org-a/g/group-a/players"
    );
  });

  it("supports a nested sub-path, e.g. a resource id", () => {
    expect(adminTenantApiPath({ organizationSlug: "org-a", groupSlug: "group-a", path: "/players/p1" })).toBe(
      "/api/admin/o/org-a/g/group-a/players/p1"
    );
  });

  it("URL-encodes slugs", () => {
    expect(adminTenantApiPath({ organizationSlug: "org with space", groupSlug: "group/slash", path: "/players" })).toBe(
      `/api/admin/o/${encodeURIComponent("org with space")}/g/${encodeURIComponent("group/slash")}/players`
    );
  });

  it("Org A and Org B (same group slug) produce distinct paths", () => {
    const a = adminTenantApiPath({ organizationSlug: "org-a", groupSlug: "indoor-soccer", path: "/players" });
    const b = adminTenantApiPath({ organizationSlug: "org-b", groupSlug: "indoor-soccer", path: "/players" });
    expect(a).not.toBe(b);
  });
});
