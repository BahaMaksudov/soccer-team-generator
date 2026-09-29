import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { publishTeamsForContext, deletePublishedTeamsForContext } from "@/lib/publishTeams";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  // Legacy route: unchanged behavior, /admin/legacy-workspace depends
  // on Telegram poll close/post via pollId.
  return publishTeamsForContext(context, req, { allowTelegramPollActions: true });
}

export async function DELETE(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return deletePublishedTeamsForContext(context, req);
}
