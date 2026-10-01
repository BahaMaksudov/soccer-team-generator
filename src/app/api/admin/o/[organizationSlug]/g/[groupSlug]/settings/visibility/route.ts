import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { getShareSettings, setGroupVisibility } from "@/lib/shareLinks";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M6-A — canonical, URL-bound Group visibility (PUBLIC / LINK / PRIVATE).
 * OWNER/ADMIN only (INSUFFICIENT_ROLE → the same generic 404). The Group
 * is the URL-resolved TenantContext.activeGroup — never a body id.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

const bodySchema = z.object({ visibility: z.enum(["PUBLIC", "LINK", "PRIVATE"]) });

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    return NextResponse.json(await getShareSettings(context));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireTenantContextForSlugs(await params);
    const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
    await setGroupVisibility(context, parsed.data.visibility);
    return NextResponse.json(await getShareSettings(context));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
