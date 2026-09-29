import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { listUnlinkedTelegramUsersForContext } from "@/lib/telegramAdmin";

/**
 * Phase 2D.6D.5B — canonical, URL-bound, read-only Telegram unlinked
 * users route. Business logic shared via src/lib/telegramAdmin.ts —
 * no Telegram Bot API call, no database write. TelegramUserLink's
 * global userId uniqueness (Phase 2D.6D.5A §7) is unchanged and
 * out of scope for this phase.
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

  return listUnlinkedTelegramUsersForContext(context);
}
