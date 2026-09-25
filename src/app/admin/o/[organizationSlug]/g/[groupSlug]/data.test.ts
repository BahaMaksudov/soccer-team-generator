import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequireTenantContextForSlugs = vi.fn();
vi.mock("@/lib/tenantContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenantContext")>();
  return { ...actual, requireTenantContextForSlugs: (...args: unknown[]) => mockRequireTenantContextForSlugs(...args) };
});

import { loadCanonicalAdminContext } from "./data";
import { TenantContextError } from "@/lib/tenantContext";

const CONTEXT_A = {
  user: { id: "u1", email: "a@example.com", name: null },
  organization: { id: "org-a", name: "Org A", slug: "org-a" },
  membership: { id: "m1", role: "OWNER" as const },
  groups: [{ id: "g-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" }],
  activeGroup: { id: "g-a", name: "Group A", slug: "group-a", sportKey: "soccer", timezone: "America/New_York" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadCanonicalAdminContext", () => {
  it("returns the resolved TenantContext on success", async () => {
    mockRequireTenantContextForSlugs.mockResolvedValue(CONTEXT_A);

    const result = await loadCanonicalAdminContext({ organizationSlug: "org-a", groupSlug: "group-a" });

    expect(result).toEqual(CONTEXT_A);
    expect(mockRequireTenantContextForSlugs).toHaveBeenCalledWith({ organizationSlug: "org-a", groupSlug: "group-a" });
  });

  it("maps NO_ORGANIZATION_MEMBERSHIP (unknown or foreign Organization) to null", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_ORGANIZATION_MEMBERSHIP"));
    const result = await loadCanonicalAdminContext({ organizationSlug: "not-real", groupSlug: "group-a" });
    expect(result).toBeNull();
  });

  it("maps NO_GROUP (unknown, foreign, or inactive Group) to null", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError("NO_GROUP"));
    const result = await loadCanonicalAdminContext({ organizationSlug: "org-a", groupSlug: "not-real" });
    expect(result).toBeNull();
  });

  it("maps every other TenantContextError code to null too (generic, non-leaking failure)", async () => {
    for (const code of ["UNAUTHENTICATED", "USER_NOT_FOUND", "INSUFFICIENT_ROLE"] as const) {
      mockRequireTenantContextForSlugs.mockRejectedValue(new TenantContextError(code));
      const result = await loadCanonicalAdminContext({ organizationSlug: "org-a", groupSlug: "group-a" });
      expect(result).toBeNull();
    }
  });

  it("rethrows a genuinely unexpected (non-TenantContextError) failure rather than silently swallowing it", async () => {
    mockRequireTenantContextForSlugs.mockRejectedValue(new Error("database is on fire"));
    await expect(loadCanonicalAdminContext({ organizationSlug: "org-a", groupSlug: "group-a" })).rejects.toThrow(
      "database is on fire"
    );
  });
});
