import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createVenue, listVenues } from "@/lib/venues";

/** M9.2 — the Organization's Venues, from a Group URL (OWNER/ADMIN; MEMBER / foreign → 404). */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    return await listVenues(await requireTenantContextForSlugs(await params));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    return await createVenue(await requireTenantContextForSlugs(await params), req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
