import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { setTelegramChatCommunity } from "@/lib/communities";

/** M9.2 — attach a connected Telegram chat to a Community of this Group (OWNER/ADMIN). */
type Params = Promise<{ organizationSlug: string; groupSlug: string; ref: string }>;

export async function PUT(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { ref, ...slugs } = await params;
  const id = Number(ref);
  try {
    const context = await requireTenantContextForSlugs(slugs);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Telegram group not found" }, { status: 404 });
    return await setTelegramChatCommunity(context, id, req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
