import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse } from "@/lib/tenantRoute";
import { previewRsvpRecipients, type PreviewRefusal } from "@/lib/rsvpPreview";

/**
 * M13B P2 — RSVP invitation recipient preview for ONE match (OWNER/ADMIN; MEMBER,
 * foreign or unknown → the same generic 404; signed out → 401). GET only and
 * read-only: no email, no records, no tokens, no usage counted. Masked
 * destinations only; never cached.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const HEADERS = { "Cache-Control": "no-store, private" };
const REFUSALS: Record<PreviewRefusal, [number, string]> = {
  NOT_FOUND: [404, "Match not found"],
  TELEGRAM_MATCH: [409, "This match uses the Telegram poll for attendance — email invitations aren't used."],
  MATCH_CANCELED: [409, "This match was canceled."],
  MATCH_COMPLETED: [409, "This match is already completed."],
  ATTENDANCE_CLOSED: [409, "Attendance for this match is closed."],
  DEADLINE_PASSED: [409, "The attendance deadline for this match has passed."],
};

export async function GET(_req: Request, { params }: { params: Params }) {
  const { matchId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const result = await previewRsvpRecipients(context, matchId);
    if (!result.ok) {
      const [status, error] = REFUSALS[result.code];
      return NextResponse.json({ error, code: result.code }, { status, headers: HEADERS });
    }
    return NextResponse.json(result.preview, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
