import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createMatch, listMatches } from "@/lib/matches";

/**
 * M9-A — canonical, URL-bound Matches of one Group. Any member may list and
 * create Matches (internal operations; nothing is sent). Tenant failures are
 * the generic 404 (401 when signed out).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    return await listMatches(context);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireTenantContextForSlugs(await params);
    return await createMatch(context, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
