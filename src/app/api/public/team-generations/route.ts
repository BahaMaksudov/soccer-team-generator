import { NextResponse } from "next/server";

/**
 * Phase 2D.5F — retired. This endpoint had zero live callers before
 * this phase (confirmed by repository-wide search, Phase 2D.5A §D and
 * re-confirmed in Phase 2D.5F §B) — it was a dead duplicate of the
 * legacy home page's own inline, globally-unscoped query. Retired
 * rather than tenant-scoped or removed: canonical history is served
 * entirely by direct server-side Prisma calls in
 * src/app/g/[organizationSlug]/[groupSlug]/data.ts, which never
 * needed this API to begin with.
 */
export async function GET() {
  return NextResponse.json({ error: "This endpoint has been retired." }, { status: 410 });
}
