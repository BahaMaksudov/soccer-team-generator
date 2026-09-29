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
 * revalidation, and the still-fully-intact Telegram branch) is 100%
 * shared with the legacy flat route via src/lib/publishTeams.ts.
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

  // Canonical route: Telegram poll actions are not exposed here yet
  // (deferred to the later Telegram migration phase) — this is a
  // server-controlled flag, never derived from the request body, so a
  // client-supplied pollId cannot activate Telegram behavior no
  // matter what the canonical UI does or doesn't send.
  return publishTeamsForContext(context, req, { allowTelegramPollActions: false });
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
