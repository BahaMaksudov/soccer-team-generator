import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { closeMatchAttendancePolls, POLL_CLOSE_MESSAGE } from "@/lib/matchPollClose";
import { telegramDenied } from "@/lib/entitlements";

/**
 * M9.2 — close the Match's open Telegram attendance poll(s) again (OWNER/ADMIN;
 * MEMBER / foreign → 404). Safe to repeat: stopPoll is idempotent. Changes no
 * teams. The recovery for "teams posted, poll still open": after a VERIFIED
 * close of a poll whose teams were posted, its one-time "Poll is closed"
 * notice is sent (never twice, never after an unclear close).
 * M11.3 — an organizer action on Telegram: Pro only (402 PLAN_LIMIT on Free). An
 * already-posted poll still closes at its attendance deadline (automation; no notice).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export async function POST(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const notInPlan = await telegramDenied(context.organization.id);
    if (notInPlan) return notInPlan;
    const match = await findGroupMatch(context, matchId);
    if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    const r = await closeMatchAttendancePolls(context.activeGroup.id, match.id, { userId: context.user.id });
    const ok = r.status === "closed" || r.status === "already_closed" || r.status === "no_poll";
    const notice = (r.notices ?? []).includes("uncertain") ? " The closure notice wasn't confirmed — check the group." : (r.notices ?? []).includes("failed") ? " Telegram refused the closure notice — you can retry it." : (r.notices ?? []).includes("sent") ? " Closure notice sent." : "";
    const message = `${POLL_CLOSE_MESSAGE[r.status] ?? ""}${ok ? notice : ""}`.trim() || null;
    return NextResponse.json({ ok, status: r.status, notices: r.notices ?? [], message, ...(ok ? {} : { error: message }) }, { status: ok ? 200 : 502 });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
