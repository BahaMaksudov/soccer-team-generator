import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { unlinkPlayerAccount } from "@/lib/playerClaims";

/**
 * M6-C — canonical, URL-bound account unlink (OWNER/ADMIN): sets the
 * Player's userId to null. Deletes nothing (User, Player, history and
 * Telegram link stay); recorded on the accepted claim (unlinkedAt/By).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; id: string }>;

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug, id } = await params;
  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    const result = await unlinkPlayerAccount(context, id);
    if (result === "not_found") return NextResponse.json({ error: "Player not found" }, { status: 404 });
    if (result === "not_claimed") return NextResponse.json({ error: "This player is not linked to an account." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
