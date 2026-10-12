import { NextResponse } from "next/server";
import { z } from "zod";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { findGroupMatch } from "@/lib/matches";
import { attendanceSummary } from "@/lib/matchAutomation";
import { checkRateLimit } from "@/lib/rateLimit";
import { MANUAL_REASON_TEXT, markGameDayUpdateSent, previewManualGameDayUpdate, sendManualGameDayUpdate } from "@/lib/gameDayUpdate";

/**
 * Manual "Send Game Day Update now" — the organizer endpoints (OWNER/ADMIN;
 * MEMBER / other tenants → the generic 404). The tenant comes from the URL;
 * the match must belong to that Group. Preview is read-only (rate-limited: it
 * may request a forecast); send needs the signed confirmation from a preview;
 * mark-as-sent only resolves an UNCERTAIN delivery after the organizer checked
 * the Telegram group. None of them reads or changes the automatic setting.
 */
const NOT_FOUND = () => NextResponse.json({ error: "Match not found" }, { status: 404 });
const sendSchema = z.object({ token: z.string().min(1).max(8000) });
const markSchema = z.object({ deliveryId: z.string().min(1).max(100) });

// Per-instance fallback when Upstash is not configured (same pattern as venue location search).
const localHits = new Map<string, number[]>();
function localAllowed(key: string, limit = 10, windowMs = 10 * 60_000, now = Date.now()): boolean {
  const hits = (localHits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  localHits.set(key, hits);
  return true;
}
export function resetGameDayPreviewLimitForTests() {
  localHits.clear();
}

async function guard(context: TenantContext, matchId: string) {
  const denied = managersOnlyResponse(context);
  if (denied) return { response: denied };
  const match = await findGroupMatch(context, matchId);
  if (!match) return { response: NOT_FOUND() };
  return { match };
}

const params = (context: TenantContext, matchId: string) => ({
  groupId: context.activeGroup.id,
  organizationId: context.organization.id,
  organizationName: context.organization.name,
  matchId,
  userId: context.user.id,
  counts: async () => (await attendanceSummary(context.activeGroup.id, matchId)).counts,
});

export async function previewGameDayUpdateForContext(context: TenantContext, matchId: string): Promise<NextResponse> {
  const g = await guard(context, matchId);
  if (g.response) return g.response;
  const key = `${context.user.id}`;
  if (!localAllowed(key) || !(await checkRateLimit("gameday-preview", key)).allowed) {
    return NextResponse.json({ error: "Too many previews. Please wait a few minutes and try again." }, { status: 429 });
  }
  const preview = await previewManualGameDayUpdate(params(context, matchId));
  if (!preview) return NOT_FOUND();
  return NextResponse.json({ preview });
}

export async function sendGameDayUpdateForContext(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const g = await guard(context, matchId);
  if (g.response) return g.response;
  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Preview the update again before sending." }, { status: 400 });
  const r = await sendManualGameDayUpdate({ ...params(context, matchId), token: parsed.data.token });
  switch (r.kind) {
    case "sent":
      return NextResponse.json({ result: "sent" });
    case "failed":
      return NextResponse.json({ result: "failed", error: "Telegram rejected the Game Day Update. Nothing was posted." }, { status: 502 });
    case "uncertain":
      return NextResponse.json({ result: "uncertain", error: "Telegram didn't confirm the Game Day Update. Check the Telegram group before doing anything else — it is never re-sent automatically." }, { status: 502 });
    case "invalid":
      return NextResponse.json({ result: "invalid", error: "Preview the update again before sending." }, { status: 400 });
    case "stale":
      return NextResponse.json(
        { result: "stale", error: r.why === "EXPIRED" ? "The preview is out of date. Review the refreshed preview and confirm again." : "The match changed since the preview. Review the refreshed preview and confirm again." },
        { status: 409 }
      );
    case "blocked":
      return NextResponse.json({ result: r.reason === "SENT" ? "already_sent" : "unavailable", reason: r.reason, error: MANUAL_REASON_TEXT[r.reason] }, { status: 409 });
  }
}

export async function markGameDayUpdateSentForContext(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const g = await guard(context, matchId);
  if (g.response) return g.response;
  const parsed = markSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });
  const r = await markGameDayUpdateSent({ groupId: context.activeGroup.id, matchId, deliveryId: parsed.data.deliveryId, userId: context.user.id });
  if (r === "ok") return NextResponse.json({ ok: true, status: "marked_sent" });
  return NextResponse.json({ error: "Only the latest uncertain Game Day Update can be marked as sent. Reload and check its status." }, { status: 409 });
}
