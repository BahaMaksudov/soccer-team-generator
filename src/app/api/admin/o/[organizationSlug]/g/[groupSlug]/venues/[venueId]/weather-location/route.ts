import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { confirmVenueLocation, removeVenueLocation } from "@/lib/geocoding";

/**
 * Phase 4B — a venue's confirmed weather location (OWNER/ADMIN; MEMBER /
 * foreign → 404). POST confirms ONE server-signed search result; DELETE removes it.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; venueId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { venueId, ...slugs } = await params;
  try {
    return await confirmVenueLocation(await requireTenantContextForSlugs(slugs), venueId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { venueId, ...slugs } = await params;
  try {
    return await removeVenueLocation(await requireTenantContextForSlugs(slugs), venueId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
