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
