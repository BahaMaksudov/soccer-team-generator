import { NextResponse } from "next/server";
import { TenantContextError } from "@/lib/tenantContext";

/**
 * Next.js-specific glue for tenant-scoped routes, kept separate from
 * src/lib/tenantContext.ts on purpose: that module is deliberately
 * framework-free (see its own header comment) so its core resolver
 * stays trivially unit-testable.
 *
 * Phase 2D.6D.5E.5 — the flat-route mapper tenantErrorResponse() was
 * removed together with the flat /api/admin/* operational routes that
 * were its only callers. (The /api/admin/tenant-context diagnostic maps
 * its own errors via tenantContextErrorStatus() and is retained until
 * Phase 2D.6D.6.)
 */

/**
 * Phase 2D.6D.1 — error mapping for URL-EXPLICIT canonical tenant
 * routes (/api/admin/o/[organizationSlug]/g/[groupSlug]/...) only.
 * (Historically separate from the legacy flat routes' own mapper,
 * which was removed in Phase 2D.6D.5E.5.)
 *
 * The reason a separate mapper is needed: tenantContextErrorStatus()
 * maps different TenantContextError codes to different HTTP statuses
 * (401/403/409) — fine for the legacy resolver, where ambiguity
 * errors like MULTIPLE_ORGANIZATIONS_REQUIRE_SELECTION are genuinely
 * different situations for the *authenticated user's own* account.
 * But for a canonical route, both `organizationSlug` and `groupSlug`
 * are attacker-guessable URL segments — if a wrong organizationSlug
 * produced a different HTTP status than a wrong groupSlug (403 vs
 * 409, respectively, under the existing mapping), that status-code
 * difference alone would let a caller determine which half of a
 * guessed URL was wrong, an existence-leak side channel purely from
 * the response code, even with an identical response body shape.
 *
 * Every TenantContextError this route can encounter collapses to the
 * same generic 404 — indistinguishable from a URL that doesn't
 * resolve to anything at all — except UNAUTHENTICATED, which stays
 * 401: middleware already gates this route on session presence, so a
 * 401 here carries no tenant-existence information, only "you're not
 * logged in," identical to what an anonymous request to any other
 * /admin/* route already reveals.
 */
export function canonicalTenantErrorResponse(e: unknown): NextResponse {
  if (e instanceof TenantContextError) {
    if (e.code === "UNAUTHENTICATED") {
      return NextResponse.json({ error: e.code }, { status: 401 });
    }
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const message = e instanceof Error ? e.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}
