import { NextResponse } from "next/server";
import { TenantContextError, tenantContextErrorStatus } from "@/lib/tenantContext";

/**
 * Maps any error thrown while resolving/using tenant context to a safe
 * NextResponse: a TenantContextError via the canonical code→status
 * mapping (never route-invented), anything else to a generic 500 —
 * matching the same "return e.message, never a raw stack trace"
 * convention already used by every other route in this codebase.
 *
 * Kept separate from src/lib/tenantContext.ts on purpose: that module
 * is deliberately framework-free (see its own header comment) so its
 * core resolver stays trivially unit-testable; this one small file is
 * the Next.js-specific glue every tenant-scoped route shares, instead
 * of each route re-writing its own try/catch mapping.
 */
export function tenantErrorResponse(e: unknown): NextResponse {
  if (e instanceof TenantContextError) {
    return NextResponse.json({ error: e.code }, { status: tenantContextErrorStatus(e.code) });
  }
  const message = e instanceof Error ? e.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * Phase 2D.6D.1 — error mapping for URL-EXPLICIT canonical tenant
 * routes (/api/admin/o/[organizationSlug]/g/[groupSlug]/...) only.
 * Deliberately separate from tenantErrorResponse() above, which is
 * NOT reused here and NOT modified — every existing legacy route's
 * error semantics stay exactly as they are.
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
