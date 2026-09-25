import { NextResponse } from "next/server";

/**
 * Phase 2D.5F — retired. This endpoint previously returned every
 * Group's players, globally unscoped, to any anonymous caller (Phase
 * 2D.5A §D/§R). Its only caller, the legacy /players page, was
 * replaced with a redirect to the canonical, tenant-scoped Players
 * API in this same phase — this route now has zero live callers and
 * is retired rather than tenant-scoped, per Phase 2D.5F §I/§N:
 * redirecting an unscoped API to a configured tenant would let API
 * callers silently receive a specific tenant's data without ever
 * asking for it by identity.
 */
export async function GET() {
  return NextResponse.json({ error: "This endpoint has been retired." }, { status: 410 });
}
