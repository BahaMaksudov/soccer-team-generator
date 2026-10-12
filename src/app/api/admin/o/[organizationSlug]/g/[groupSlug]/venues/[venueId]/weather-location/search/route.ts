import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { searchVenueLocation } from "@/lib/geocoding";

/**
 * Phase 4B — search candidate weather locations for a venue (OWNER/ADMIN;
 * MEMBER / foreign → 404; rate-limited). Stores nothing.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; venueId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { venueId, ...slugs } = await params;
  try {
    return await searchVenueLocation(await requireTenantContextForSlugs(slugs), venueId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
