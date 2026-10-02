import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { issueTelegramBindCode, listTelegramChannels } from "@/lib/telegramChannels";

/** M9-A — Communication Channels → Telegram (OWNER/ADMIN). GET lists connected chats (titles, opaque refs); POST issues a one-time bind code. */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    return await listTelegramChannels(context);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireTenantContextForSlugs(await params);
    return await issueTelegramBindCode(context);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
