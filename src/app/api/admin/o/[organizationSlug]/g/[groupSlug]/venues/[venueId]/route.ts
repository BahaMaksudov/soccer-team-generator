import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { updateVenue } from "@/lib/venues";

/** M9.2 — edit / (de)activate a Venue of this Organization (OWNER/ADMIN; foreign → 404). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; venueId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { venueId, ...slugs } = await params;
  try {
    return await updateVenue(await requireTenantContextForSlugs(slugs), venueId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
