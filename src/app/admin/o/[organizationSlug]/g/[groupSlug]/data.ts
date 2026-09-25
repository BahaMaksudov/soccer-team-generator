import { requireTenantContextForSlugs, TenantContextError, type TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6C — resolver gate for the canonical Admin tenant page.
 * Same plain-.ts-loader pattern established for the public canonical
 * routes (Phase 2D.5B+): keeps the security-critical resolution
 * logic testable without a JSX transform.
 *
 * Every TenantContextError (unknown Organization, not a member,
 * unknown/foreign/inactive Group, or even an unexpected
 * UNAUTHENTICATED/USER_NOT_FOUND at this point) collapses to the same
 * `null` result here — the page turns that into a generic 404. This
 * is a deliberate, local choice in this one loader (not a change to
 * tenantContextErrorStatus() or any existing API's error semantics):
 * an authenticated Admin visitor who lands on a URL they don't have
 * access to must never be able to distinguish "that Organization/
 * Group doesn't exist" from "it exists but isn't yours" (Phase 2D.6C
 * report §H).
 */
export async function loadCanonicalAdminContext(params: {
  organizationSlug: string;
  groupSlug: string;
}): Promise<TenantContext | null> {
  try {
    return await requireTenantContextForSlugs(params);
  } catch (e) {
    if (e instanceof TenantContextError) return null;
    throw e;
  }
}
