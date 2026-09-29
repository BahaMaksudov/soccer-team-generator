import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { publishTeamsForContext, deletePublishedTeamsForContext } from "@/lib/publishTeams";

/**
 * Phase 2D.6D.3 — canonical, URL-bound Publish route. Tenant identity
 * comes exclusively from the URL's (organizationSlug, groupSlug) pair,
 * resolved and authorized fresh on every request via
 * requireTenantContextForSlugs() — never from body groupId/
 * organizationId, which publishTeamsForContext() never reads at all.
 * Business logic (validation, the atomic (groupId, date) upsert,
 * revalidation) lives in src/lib/publishTeams.ts, which is DB-only as
 * of Phase 2D.6D.5E.5 — Publish never contacts Telegram. Teams reach
 * Telegram only via the separate canonical telegram/close-and-post
 * route.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return publishTeamsForContext(context, req);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return deletePublishedTeamsForContext(context, req);
}
