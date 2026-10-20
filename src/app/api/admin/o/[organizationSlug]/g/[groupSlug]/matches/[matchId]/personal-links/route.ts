import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { issuePersonalLinks, organizerLinksView, revokePersonalLink } from "@/lib/personalAttendance";

/**
 * M12B — personal attendance links of ONE Match (OWNER/ADMIN; MEMBER / foreign → 404).
 *   GET  → roster with link status (created / last used — never tokens) and responses.
 *   POST { action: "issue", playerIds? } → new links (regenerating revokes the previous
 *        ones); the raw links are returned ONCE for the organizer to copy and send.
 *   POST { action: "revoke", playerId } → that Player's link stops working.
 * Website-only matches only (a Telegram poll match → 409). Nothing is sent to anyone.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), playerIds: z.array(z.string().min(1).max(64)).max(300).optional() }),
  z.object({ action: z.literal("revoke"), playerId: z.string().min(1).max(64) }),
]);

export async function GET(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const view = await organizerLinksView(context.activeGroup.id, matchId);
    if (!view) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    return NextResponse.json(view, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (parsed.data.action === "revoke") {
      const ok = await revokePersonalLink(context.activeGroup.id, matchId, parsed.data.playerId);
      return ok ? NextResponse.json({ ok: true }, { headers: HEADERS }) : NextResponse.json({ error: "No active link for that player." }, { status: 404 });
    }
    const r = await issuePersonalLinks({ organizationId: context.organization.id, groupId: context.activeGroup.id, matchId, userId: context.user.id, playerIds: parsed.data.playerIds });
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "NOT_FOUND" ? 404 : 409 });
    return NextResponse.json({ ok: true, links: r.links }, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
