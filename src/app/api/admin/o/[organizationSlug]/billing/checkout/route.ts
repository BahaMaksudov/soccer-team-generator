import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { startCheckout } from "@/lib/billing/checkout";

/**
 * M11.2A — start Stripe Checkout for Pro (OWNER only; ADMIN / MEMBER / foreign
 * → the generic 404). Body: { interval: "month" | "year" } — nothing else is
 * read; the Price comes from the server allow-list. Returns { url } (Stripe-hosted).
 */
type Params = Promise<{ organizationSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireOrganizationContextForSlug(await params);
    return await startCheckout(context, await req.json().catch(() => null));
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
