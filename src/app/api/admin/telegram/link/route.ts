import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { linkTelegramUserForContext } from "@/lib/telegramAdmin";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return linkTelegramUserForContext(context, req);
}
