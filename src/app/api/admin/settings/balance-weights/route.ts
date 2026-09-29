import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";
import {
  getBalanceWeightsForContext,
  saveBalanceWeightsForContext,
  revalidateLegacyBalanceWeightsPages,
} from "@/lib/groupSettings";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  return getBalanceWeightsForContext(context);
}

async function save(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const res = await saveBalanceWeightsForContext(context, req);

  // Only revalidate on success — matches the original route's
  // behavior exactly (revalidatePath ran after the upsert succeeded,
  // never on the early 400 validation-failure return).
  if (res.ok) {
    revalidateLegacyBalanceWeightsPages();
  }

  return res;
}

export async function POST(req: Request) {
  return save(req);
}

export async function PUT(req: Request) {
  return save(req);
}
