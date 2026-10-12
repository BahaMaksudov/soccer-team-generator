import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { getGameDayUpdateSettings, saveGameDayUpdateSettings } from "@/lib/gameDayUpdateSettings";

/**
 * Phase 4B — the Group's Telegram Game Day Update settings (OWNER/ADMIN;
 * MEMBER / foreign → the generic 404). Tenant from the URL only; logic in
 * src/lib/gameDayUpdateSettings.ts. Settings only — nothing is sent here.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    return await getGameDayUpdateSettings(await requireTenantContextForSlugs(await params));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: { params: Params }) {
  try {
    return await saveGameDayUpdateSettings(await requireTenantContextForSlugs(await params), req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
