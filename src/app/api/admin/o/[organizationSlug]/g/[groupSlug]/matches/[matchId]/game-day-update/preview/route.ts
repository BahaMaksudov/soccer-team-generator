import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { previewGameDayUpdateForContext } from "@/lib/gameDayManual";

/** Manual Game Day Update — read-only preview: destination, exact message, weather check (OWNER/ADMIN; rate-limited). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await previewGameDayUpdateForContext(context, matchId);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
