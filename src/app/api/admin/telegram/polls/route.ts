import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { listTelegramPollsForContext } from "@/lib/telegramAdmin";

export async function GET(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return listTelegramPollsForContext(context, req);
}
