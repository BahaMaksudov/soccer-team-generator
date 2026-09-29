import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { linkTelegramUserForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5C — canonical, URL-bound Telegram user-linking route.
 * Business logic shared via src/lib/telegramAdmin.ts — target Player
 * ownership verified before any write; the existing cross-Group
 * TelegramUserLink 409 guard is unchanged. No Telegram Bot API call.
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

  return linkTelegramUserForContext(context, req);
}
