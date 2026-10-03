import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { setMatchTelegramChat } from "@/lib/telegramChatScope";

/** M9-B — select/clear the Match's Telegram chat (OWNER/ADMIN). Context only; sends nothing. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    return await setMatchTelegramChat(context, matchId, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
