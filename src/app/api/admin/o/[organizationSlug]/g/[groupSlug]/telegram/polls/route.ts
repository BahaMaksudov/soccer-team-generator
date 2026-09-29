import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { listTelegramPollsForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5B — canonical, URL-bound, read-only Telegram polls
 * route. Preserves the legacy includeClosed=1 query contract exactly.
 * Business logic shared via src/lib/telegramAdmin.ts — no Telegram Bot
 * API call, no database write.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return listTelegramPollsForContext(context, req);
}
