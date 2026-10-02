import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { disconnectTelegramChannel } from "@/lib/telegramChannels";

/** M9-A — disconnect one Telegram chat from this Group (OWNER/ADMIN). History is kept. */
type Params = Promise<{ organizationSlug: string; groupSlug: string; ref: string }>;

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { ref, ...slugs } = await params;
  const id = Number(ref);
  try {
    const context = await requireTenantContextForSlugs(slugs);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Telegram group not found" }, { status: 404 });
    return await disconnectTelegramChannel(context, id);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
