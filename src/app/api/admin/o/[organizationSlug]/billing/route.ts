import { NextResponse } from "next/server";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { accountRouteErrorResponse } from "@/lib/tenantRoute";
import { billingView } from "@/lib/billing/checkout";

/** M11.2A — billing status (OWNER + ADMIN read-only; MEMBER / foreign → the generic 404). No card data. */
type Params = Promise<{ organizationSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const view = await billingView(await requireOrganizationContextForSlug(await params));
    if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
