import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { importTelegramPollForContext } from "@/lib/telegramAdmin";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return importTelegramPollForContext(context, req);
}
