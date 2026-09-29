import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { createTelegramPollForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5C — canonical, URL-bound Telegram create-poll route.
 * Same tenant-resolution/error-mapping pattern as every other
 * canonical route. Business logic shared via src/lib/telegramAdmin.ts
 * — the ownership check (TelegramChat belongs to
 * context.activeGroup.id) happens before any Telegram Bot API call,
 * exactly as in the legacy route.
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

  return createTelegramPollForContext(context, req);
}
