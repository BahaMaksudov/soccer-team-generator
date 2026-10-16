import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { recoverPollClosedNotice } from "@/lib/pollClosure";

/**
 * Telegram publishing — recovery for the one-time "Poll is closed" notice (OWNER/ADMIN;
 * MEMBER / foreign → 404): "retry" only a notice Telegram definitely refused;
 * "mark_sent" only an uncertain one the organizer found in the chat. Never re-sends otherwise.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const schema = z.object({ action: z.enum(["retry", "mark_sent"]), deliveryId: z.string().min(1).max(100) });
const MESSAGES: Record<string, string> = {
  sent: "Closure notice sent.",
  marked_sent: "Closure notice marked as sent.",
  failed: "Telegram refused the closure notice again.",
  uncertain: "Telegram didn't confirm the closure notice. Check the group — it won't be sent again automatically.",
  not_failed: "Only a closure notice that Telegram refused can be retried. Reload and check its status.",
  not_uncertain: "Only an unconfirmed closure notice can be marked as sent. Reload and check its status.",
  not_latest: "That isn't the latest closure notice. Reload and check its status.",
  poll_not_closed: "The poll isn't confirmed closed, so no closure notice is sent.",
  exists: "The closure notice was already handled.",
};

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const match = await findGroupMatch(context, matchId);
    if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Closure notice not found." }, { status: 404 });
    const r = await recoverPollClosedNotice({ groupId: context.activeGroup.id, matchId: match.id, deliveryId: parsed.data.deliveryId, action: parsed.data.action, userId: context.user.id });
    if (r.result === "not_found") return NextResponse.json({ error: "Closure notice not found." }, { status: 404 });
    const message = MESSAGES[r.result] ?? "Something went wrong.";
    return NextResponse.json(r.ok ? { ok: true, result: r.result, message } : { ok: false, result: r.result, error: message }, { status: r.ok ? 200 : 409 });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
