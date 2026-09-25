import { NextResponse } from "next/server";

/**
 * Phase 2D.5F — retired. This endpoint had zero live callers before
 * this phase (only a commented-out dead reference in SiteHeader.tsx,
 * confirmed by repository-wide search in Phase 2D.5A §D and
 * re-confirmed in Phase 2D.5F §B). It previously returned the global
 * AppSetting.teamName value to any anonymous caller. Canonical
 * branding is served entirely by the tenant-scoped
 * /api/public/[organizationSlug]/[groupSlug]/team-name, which never
 * needed this API to begin with.
 */
export async function GET() {
  return NextResponse.json({ error: "This endpoint has been retired." }, { status: 410 });
}
