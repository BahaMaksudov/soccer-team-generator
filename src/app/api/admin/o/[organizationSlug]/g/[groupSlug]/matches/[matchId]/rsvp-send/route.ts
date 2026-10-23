import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireTenantContextForSlugs, TenantContextError } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { checkRateLimit } from "@/lib/rateLimit";
import { createRsvpSend, processRsvpQueue, retryFailedInvitations, rsvpDeliveryAllowedFor, type SendRefusal } from "@/lib/rsvpSend";
import { rsvpStatusView } from "@/lib/rsvpStatus";

/**
 * M13B P5 — organizer RSVP email sending for ONE match (OWNER/ADMIN; MEMBER, foreign or
 * unknown → the same generic 404; signed out → 401).
 *   GET  → delivery dashboard (delivery status and RSVP status, separately; masked only).
 *   POST { action: "send", kind, requestKey, expectedCount, attested: true }
 *        → queue invitations for the roster the server re-derives (the request can't name
 *          recipients, addresses or content), then deliver a first bounded batch.
 *   POST { action: "retry", sendId } → re-queue that send's FAILED invitations.
 * Delivery happens only where rsvpDeliveryAllowedFor() allows it for this organization:
 * the in-memory test outbox (tests / confirmed local test env) or, once separately
 * approved, the Production-only live pilot for allowlisted organizations. Everywhere
 * else — Preview always — POST is refused with 403 DELIVERY_DISABLED before the body is
 * read or anything is written (a non-allowlisted organization gets the same answer). JSON + same-origin only (CSRF); rate limited per organizer (Upstash,
 * optional) and per organization (database, authoritative); idempotent per requestKey.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const HEADERS = { "Cache-Control": "no-store, private" };
const SENDS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;
const INLINE_BUDGET_MS = 8_000;

const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("send"),
      kind: z.enum(["INITIAL", "RESEND"]),
      requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      expectedCount: z.number().int().min(1).max(1000),
      attested: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal("retry"), sendId: z.string().min(1).max(64) }).strict(),
]);

const REFUSALS: Record<SendRefusal | "RATE_LIMITED", [number, string]> = {
  NOT_FOUND: [404, "Match not found"],
  TELEGRAM_MATCH: [409, "This match uses the Telegram poll for attendance — email invitations aren't used."],
  MATCH_CANCELED: [409, "This match was canceled."],
  MATCH_COMPLETED: [409, "This match is already completed."],
  ATTENDANCE_CLOSED: [409, "Attendance for this match is closed."],
  DEADLINE_PASSED: [409, "The RSVP deadline for this match has passed, so invitations can't be sent."],
  DELIVERY_DISABLED: [403, "Email sending isn't available yet."],
  INVALID_REQUEST: [400, "Invalid request."],
  REQUEST_KEY_CONFLICT: [409, "This request was already used for something else. Reload the page and try again."],
  ALREADY_SENT: [409, "Invitations were already sent for this match. Use “Resend to unanswered” instead."],
  NOTHING_TO_RESEND: [409, "There is nobody to resend to — everyone invited has answered, or invitations haven't been sent yet."],
  NOTHING_TO_SEND: [409, "Nobody on this match's roster can be invited by email right now."],
  PLAN_LIMIT: [409, "Your organization has used its RSVP email allowance for now. The daily allowance resets at 00:00 UTC, the monthly one on the 1st."],
  ROSTER_CHANGED: [409, "The recipient list changed since you reviewed it. Review it again before sending."],
  RATE_LIMITED: [429, "Too many send requests. Please wait a few minutes."],
};
const refuse = (code: keyof typeof REFUSALS, extra: Record<string, unknown> = {}) => {
  const [status, error] = REFUSALS[code];
  return NextResponse.json({ error, code, ...extra }, { status, headers: HEADERS });
};

/** Tenant errors map as everywhere else; anything else is a generic 500 (never an internal message). */
const failure = (e: unknown) => (e instanceof TenantContextError ? canonicalTenantErrorResponse(e) : NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS }));

export async function GET(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const view = await rsvpStatusView(context, matchId);
    if (!view) return NextResponse.json({ error: "Match not found" }, { status: 404, headers: HEADERS });
    return NextResponse.json(view, { headers: HEADERS });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: HEADERS });
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    // Server-side delivery gate — before parsing, reading or writing anything.
    if (!rsvpDeliveryAllowedFor(context.organization.id)) return refuse("DELIVERY_DISABLED");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse("INVALID_REQUEST");
    if (!(await checkRateLimit("rsvp-send", context.user.id)).allowed) return refuse("RATE_LIMITED");

    if (parsed.data.action === "retry") {
      const r = await retryFailedInvitations(context, parsed.data.sendId);
      if (!r.ok) return refuse(r.code);
      const run = r.requeued > 0 ? await processRsvpQueue({ sendId: parsed.data.sendId, budgetMs: INLINE_BUDGET_MS }) : null;
      return NextResponse.json({ ok: true, requeued: r.requeued, notRetried: r.left, run }, { headers: HEADERS });
    }

    const { kind, requestKey, expectedCount } = parsed.data;
    // Database-backed limit (fails closed): new sends per organization per 10 minutes.
    // A repeated requestKey is not a new send, so it is answered before this check.
    const existing = await prisma.rsvpSend.findUnique({ where: { requestKey }, select: { id: true } });
    if (!existing) {
      const recent = await prisma.rsvpSend.count({ where: { organizationId: context.organization.id, createdAt: { gt: new Date(Date.now() - WINDOW_MS) } } });
      if (recent >= SENDS_PER_WINDOW) return refuse("RATE_LIMITED");
    }
    const r = await createRsvpSend(context, matchId, { kind, requestKey, expectedCount, attested: true });
    if (!r.ok) return refuse(r.code, r.willSend !== undefined ? { willSend: r.willSend } : {});
    const run = r.duplicate ? null : await processRsvpQueue({ sendId: r.sendId, budgetMs: INLINE_BUDGET_MS });
    return NextResponse.json({ ok: true, sendId: r.sendId, round: r.round, duplicate: r.duplicate, counts: r.counts, run }, { headers: HEADERS });
  } catch (e) {
    return failure(e);
  }
}
