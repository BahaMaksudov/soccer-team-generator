import { NextResponse } from "next/server";
import {
  requireTenantContext,
  tenantContextErrorStatus,
  TenantContextError,
} from "@/lib/tenantContext";

/**
 * Safe diagnostic endpoint for Phase 2D.1's tenant-context foundation.
 *
 * Already gated by middleware.ts's matcher (/api/admin/:path*) — a
 * valid admin session is required just to reach this handler at all.
 * Returns only the same allow-listed TenantContext DTO the canonical
 * helper produces: no passwordHash, no Telegram credentials, no
 * secrets, nothing beyond what resolveTenantContextForEmail()
 * constructs field-by-field.
 *
 * Not wired into any existing route or UI — this exists purely to
 * validate the helper end-to-end through the real authenticated
 * request path, and may be retained as a small ops/debug tool.
 */
export async function GET() {
  try {
    const context = await requireTenantContext();
    return NextResponse.json({ ok: true, context });
  } catch (e) {
    if (e instanceof TenantContextError) {
      return NextResponse.json({ ok: false, error: e.code }, { status: tenantContextErrorStatus(e.code) });
    }
    // Never leak internal error details to the client.
    return NextResponse.json({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
