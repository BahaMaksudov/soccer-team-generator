import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { importTelegramPollForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5C — canonical, URL-bound Telegram poll-import route.
 * Business logic shared via src/lib/telegramAdmin.ts — poll/answer/
 * link reads all scoped to context.activeGroup.id, plus the
 * defense-in-depth Player verification described there. No Telegram
 * Bot API call, no DB write.
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

  return importTelegramPollForContext(context, req);
}
