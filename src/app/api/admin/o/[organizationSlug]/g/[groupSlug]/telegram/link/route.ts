import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { linkTelegramUserForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5C — canonical, URL-bound Telegram user-linking route.
 * Business logic shared via src/lib/telegramAdmin.ts — target Player
 * ownership verified before any write; the existing cross-Group
 * TelegramUserLink 409 guard is unchanged. No Telegram Bot API call.
 * M6.1: OWNER/ADMIN only (MEMBER → generic 404).
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    // Inside the try: the OWNER/ADMIN role check (M6.1) throws a
    // TenantContextError that must map to the generic 404, not a 500.
    return await linkTelegramUserForContext(context, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
