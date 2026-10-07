import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { closeMatchAttendancePolls, POLL_CLOSE_MESSAGE } from "@/lib/matchPollClose";

/**
 * M9.2 — close the Match's open Telegram attendance poll(s) again (OWNER/ADMIN;
 * MEMBER / foreign → 404). Safe to repeat: stopPoll is idempotent. Sends no
 * message and changes no teams.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const match = await findGroupMatch(context, matchId);
    if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    const r = await closeMatchAttendancePolls(context.activeGroup.id, match.id);
    const ok = r.status === "closed" || r.status === "already_closed" || r.status === "no_poll";
    const message = POLL_CLOSE_MESSAGE[r.status];
    return NextResponse.json({ ok, status: r.status, message, ...(ok ? {} : { error: message }) }, { status: ok ? 200 : 502 });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
