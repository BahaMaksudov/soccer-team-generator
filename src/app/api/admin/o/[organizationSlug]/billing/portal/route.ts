import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { accountRouteErrorResponse } from "@/lib/tenantRoute";
import { openPortal } from "@/lib/billing/checkout";

/** M11.2A — Stripe Customer Portal for THIS Organization (OWNER only; others → the generic 404). Returns { url }. */
type Params = Promise<{ organizationSlug: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  try {
    return await openPortal(await requireOrganizationContextForSlug(await params));
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
