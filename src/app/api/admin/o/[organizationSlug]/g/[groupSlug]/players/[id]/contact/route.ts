import { NextResponse } from "next/server";
import { requireTenantContextForSlugs, TenantContextError } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { getPlayerContact, setPlayerContact } from "@/lib/playerContact";

/**
 * M13B P1 — one Player's organizer-entered contact email (OWNER/ADMIN; MEMBER,
 * foreign or unknown → the same generic 404). Loaded only when an organizer opens
 * the player's details, so rosters never carry addresses.
 *   GET → { contact: { email, type, updatedAt } | null, linkedAccount: { linked, verified } }
 *   PUT { email: string | null, type?: "PLAYER" | "GUARDIAN", authorized?: true } → set (type
 *       required; a new or materially changed contact also needs authorized: true — the
 *       organizer's confirmation, recorded with who and when) or clear (blank / null)
 * Sends nothing. Never logs addresses.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; id: string }>;
const HEADERS = { "Cache-Control": "no-store" };
/** P6 — tenant errors map as everywhere else; anything else is a generic 500 (a database error can quote row data). */
const failure = (e: unknown) => (e instanceof TenantContextError ? canonicalTenantErrorResponse(e) : NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: HEADERS }));

export async function GET(_req: Request, { params }: { params: Params }) {
  const { id, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const view = await getPlayerContact(context, id);
    return view ? NextResponse.json(view, { headers: HEADERS }) : NextResponse.json({ error: "Player not found" }, { status: 404 });
  } catch (e) {
    return failure(e);
  }
}

export async function PUT(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { id, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const body = (await req.json().catch(() => null)) as { email?: unknown; type?: unknown; authorized?: unknown } | null;
    if (!body || typeof body !== "object" || !("email" in body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const result = await setPlayerContact(context, id, { email: body.email, type: body.type, authorized: body.authorized });
    if (!result.ok && result.code === "NOT_FOUND") return NextResponse.json({ error: "Player not found" }, { status: 404 });
    if (!result.ok) return NextResponse.json({ error: result.error, issues: { formErrors: [], fieldErrors: { [result.field]: [result.error] } } }, { status: 400 });
    return NextResponse.json(result.view, { headers: HEADERS });
  } catch (e) {
    return failure(e);
  }
}
