import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { getTeamNameForContext, saveTeamNameForContext } from "@/lib/groupSettings";

/**
 * Phase 2D.6D.4 — canonical, URL-bound Group teamName settings route.
 * Tenant identity comes exclusively from the URL's (organizationSlug,
 * groupSlug) pair, resolved and authorized fresh on every request via
 * requireTenantContextForSlugs() — never from body groupId/
 * organizationId, which saveTeamNameForContext() never reads at all.
 * Business logic is 100% shared with the legacy flat route via
 * src/lib/groupSettings.ts. No revalidatePath() here — see that
 * module's header comment for why none is needed on this path.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return getTeamNameForContext(context);
}

async function save(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return saveTeamNameForContext(context, req);
}

export async function POST(req: Request, ctx: { params: Params }) {
  return save(req, ctx);
}

export async function PUT(req: Request, ctx: { params: Params }) {
  return save(req, ctx);
}
