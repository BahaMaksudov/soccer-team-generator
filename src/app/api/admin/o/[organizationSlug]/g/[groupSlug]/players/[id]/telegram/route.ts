import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { removePlayerTelegramLink } from "@/lib/telegramIdentity";

/**
 * M6.1 — canonical, URL-bound "Remove Telegram link" (OWNER/ADMIN).
 * Deletes only this Player's TelegramUserLink in this Group; the Player,
 * its account, history and the same Telegram identity's links in other
 * Groups are untouched. Idempotent (`removed: false` when nothing was
 * linked). Never returns the Telegram user id. No Telegram API call.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; id: string }>;

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug, id } = await params;
  try {
    const context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
    const result = await removePlayerTelegramLink(context, id);
    if (result === "not_found") return NextResponse.json({ error: "Player not found" }, { status: 404 });
    return NextResponse.json({ ok: true, removed: result === "removed" });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
