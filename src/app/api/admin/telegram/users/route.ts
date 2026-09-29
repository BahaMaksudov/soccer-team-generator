import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { listUnlinkedTelegramUsersForContext } from "@/lib/telegramAdmin";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return listUnlinkedTelegramUsersForContext(context);
}
