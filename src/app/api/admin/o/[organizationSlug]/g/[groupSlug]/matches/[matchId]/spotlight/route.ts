import { NextResponse } from "next/server";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { normalizeSpotlightNote, selectSpotlight, spotlightView, updateSpotlightNote, type SpotlightOutcome } from "@/lib/spotlight";

/**
 * Random Player Spotlight for one Match (OWNER/ADMIN; MEMBER / other tenants → 404).
 *   GET    the saved selection + cycle progress (never selects)
 *   POST   { action: "select" }  draw once (idempotent: repeats return the same player)
 *          { action: "replace" } only when the selected player is no longer playing
 *   PATCH  { note }               the organizer's text under the name (plain text, ≤ 200)
 * The Group comes from the URL only. Nothing here sends anything to Telegram.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;
const HEADERS = { "Cache-Control": "no-store" };

const STATUS: Record<Exclude<SpotlightOutcome, { ok: true }>["code"], number> = { NOT_FOUND: 404, NO_CONFIRMED: 409, ALL_ATTENDEES_SELECTED: 409, STILL_ATTENDING: 409, NO_PICK: 409 };
function respond(out: SpotlightOutcome): NextResponse {
  if (out.ok) return NextResponse.json({ ...out.view, created: out.created }, { headers: HEADERS });
  return NextResponse.json({ error: out.message, code: out.code, ...(out.view ? { view: out.view } : {}) }, { status: STATUS[out.code], headers: HEADERS });
}

async function contextFor(params: Params) {
  const { matchId, ...slugs } = await params;
  const context = await requireTenantContextForSlugs(slugs);
  return { context, matchId: typeof matchId === "string" ? matchId.slice(0, 64) : "" };
}

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    const { context, matchId } = await contextFor(params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const view = await spotlightView(context.activeGroup.id, matchId);
    if (!view) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    return NextResponse.json(view, { headers: HEADERS });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const { context, matchId } = await contextFor(params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "select" && body?.action !== "replace") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    return respond(await selectSpotlight(context.activeGroup.id, matchId, context.user.id, { replace: body.action === "replace" }));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const { context, matchId } = await contextFor(params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
    const note = normalizeSpotlightNote(body?.note);
    if (!note.ok) return NextResponse.json({ error: note.error }, { status: 400 });
    return respond(await updateSpotlightNote(context.activeGroup.id, matchId, note.note));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
