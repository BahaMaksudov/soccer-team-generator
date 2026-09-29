import { NextResponse } from "next/server";
import { TenantContextError } from "@/lib/tenantContext";

/**
 * Next.js-specific glue for tenant-scoped routes, kept separate from
 * src/lib/tenantContext.ts on purpose: that module is deliberately
 * framework-free (see its own header comment) so its core resolver
 * stays trivially unit-testable.
 *
 * Every /api/admin route is URL-bound (/api/admin/o/[org]/g/[group]/…)
 * and maps tenant errors with canonicalTenantErrorResponse() below. The
 * old flat-route mapper and the single-tenant resolver it served were
 * removed in Phases 2D.6D.5E.5 and 2D.6D.6.
 */

/**
 * Phase 2D.6D.1 — error mapping for URL-EXPLICIT canonical tenant
 * routes (/api/admin/o/[organizationSlug]/g/[groupSlug]/...).
 *
 * Why every tenant failure maps to the same status: both
 * `organizationSlug` and `groupSlug` are attacker-guessable URL
 * segments. If a wrong organizationSlug (NO_ORGANIZATION_MEMBERSHIP)
 * produced a different HTTP status than a wrong groupSlug (NO_GROUP),
 * that status-code difference alone would let a caller determine which
 * half of a guessed URL was wrong — an existence-leak side channel
 * purely from the response code, even with an identical body shape.
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
