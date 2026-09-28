import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { generateTeamsForContext } from "@/lib/generateTeams";

/**
 * Phase 2D.6D.2 — canonical, URL-bound Generate route. Tenant identity
 * comes exclusively from the URL's (organizationSlug, groupSlug) pair,
 * resolved and authorized fresh on every request via
 * requireTenantContextForSlugs() — never from body groupId/
 * organizationId, which generateTeamsForContext() never reads at all.
 * Business logic (validation, Player scoping, balanceWeights lookup,
 * balancing) is 100% shared with the legacy flat route via
 * src/lib/generateTeams.ts.
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

  return generateTeamsForContext(context, req);
}
