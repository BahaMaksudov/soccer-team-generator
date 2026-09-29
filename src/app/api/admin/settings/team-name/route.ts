import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import { getTeamNameForContext, saveTeamNameForContext, revalidateLegacyTeamNamePages } from "@/lib/groupSettings";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return getTeamNameForContext(context);
}

async function saveTeamName(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const res = await saveTeamNameForContext(context, req);

  // Only revalidate on success — a validation failure (400) never
  // reaches the upsert, so there's nothing to revalidate, exactly
  // matching the original route's behavior (revalidatePath was always
  // called after the upsert succeeded, never on the early 400 return).
  //
  // Never write AppSetting.teamName here — GroupSetting is the sole
  // authoritative source for authenticated Admin settings as of
  // Phase 2D.4. AppSetting remains for legacy/public reads only,
  // deliberately not kept in sync (see Phase 2D.4 report §J).
  if (res.ok) {
    revalidateLegacyTeamNamePages();
  }

  return res;
}

// Admin UI calls both POST and PUT historically — keep both working.
export async function POST(req: Request) {
  return saveTeamName(req);
}

export async function PUT(req: Request) {
  return saveTeamName(req);
}
