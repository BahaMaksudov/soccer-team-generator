import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createJoinLink, JOIN_LINK_DAYS, listJoinLinks, revokeJoinLink } from "@/lib/groupJoin";

/**
 * M13A — the Group's invitation (join) links. OWNER/ADMIN only (MEMBER, foreign
 * or unknown Group → generic 404), re-checked in the database on every request.
 *   GET  → links with state and pending-request counts (never tokens).
 *   POST { action: "create", days?, replace? } → a new link; the raw link is returned
 *        ONCE for the organizer to copy. While a link is active → 409
 *        ACTIVE_LINK_EXISTS unless replace: true (the organizer confirmed that the
 *        previously shared link stops working).
 *   POST { action: "revoke", linkId } → that link stops accepting NEW requests.
 * Nothing is sent to anyone.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), days: z.number().int().min(JOIN_LINK_DAYS.min).max(JOIN_LINK_DAYS.max).optional(), replace: z.boolean().optional() }),
  z.object({ action: z.literal("revoke"), linkId: z.string().min(1).max(64) }),
]);

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const context = await requireTenantContextForSlugs(await params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    return NextResponse.json({ links: await listJoinLinks(context) }, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const context = await requireTenantContextForSlugs(await params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (parsed.data.action === "revoke") {
      return (await revokeJoinLink(context, parsed.data.linkId))
        ? NextResponse.json({ ok: true }, { headers: HEADERS })
        : NextResponse.json({ error: "No active invite link with that id." }, { status: 404 });
    }
    const link = await createJoinLink(context, { days: parsed.data.days, replace: parsed.data.replace });
    if (!link.ok) {
      return NextResponse.json(
        { error: "This group already has an active invite link. Replacing it stops the link you shared before from working.", code: link.code },
        { status: 409, headers: HEADERS }
      );
    }
    return NextResponse.json({ ok: true, id: link.id, path: link.path, expiresAt: link.expiresAt.toISOString(), replaced: link.replaced }, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
