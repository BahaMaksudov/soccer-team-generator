import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { getTeamsDeliveryStatusForContext, markTeamsDeliverySentForContext } from "@/lib/telegramCloseAndPost";

/**
 * M6-B — canonical, URL-bound Telegram teams-delivery status + recovery.
 * GET  ?pollId=&teamGenerationId=  → state + safe actions (read-only).
 * POST { action: "mark_sent", deliveryId } → organizer confirms an
 *      uncertain delivery that IS in the chat (never sends anything).
 * Every lookup is scoped to the URL-resolved Group; foreign ids are 404.
 * Sending/retrying stays on telegram/close-and-post.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  let context;
  try {
    context = await requireTenantContextForSlugs(await params);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
  return getTeamsDeliveryStatusForContext(context, req);
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  let context;
  try {
    context = await requireTenantContextForSlugs(await params);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
  return markTeamsDeliverySentForContext(context, req);
}
