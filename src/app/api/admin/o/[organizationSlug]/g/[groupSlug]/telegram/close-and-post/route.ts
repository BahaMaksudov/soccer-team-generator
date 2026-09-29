import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { closePollAndPostTeamsForContext } from "@/lib/telegramCloseAndPost";

/**
 * Phase 2D.6D.5D — canonical, URL-bound Close Poll + Post Teams route.
 * Tenant identity comes only from the URL slugs; the body carries just
 * { pollId, teamGenerationId }. All validation, the posting state
 * machine, and every Telegram call live in
 * src/lib/telegramCloseAndPost.ts. There is no legacy flat equivalent.
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

  return closePollAndPostTeamsForContext(context, req);
}
