import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { getBalanceWeightsForContext, saveBalanceWeightsForContext } from "@/lib/groupSettings";

/**
 * Phase 2D.6D.4 — canonical, URL-bound Group balanceWeights settings
 * route. Same tenant-resolution/error-mapping pattern as the
 * team-name canonical route. Business logic shared via
 * src/lib/groupSettings.ts. No revalidatePath() here — canonical
 * Generate already reads GroupSetting.balanceWeights fresh via Prisma
 * on every request, so there is no caching layer to invalidate.
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

  return getBalanceWeightsForContext(context);
}

async function save(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return saveBalanceWeightsForContext(context, req);
}

export async function POST(req: Request, ctx: { params: Params }) {
  return save(req, ctx);
}

export async function PUT(req: Request, ctx: { params: Params }) {
  return save(req, ctx);
}
