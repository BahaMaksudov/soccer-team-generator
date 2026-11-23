import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { buildReusedTeams, reusePlan, reuseSources } from "@/lib/reuseTeams";

/**
 * Reuse previous teams for this Match (OWNER/ADMIN; MEMBER / other tenants → 404).
 *   GET               earlier publications of this Match's Community (or, for a whole-Group
 *                     Match, community-less ones), newest first
 *   GET ?source=<id>  the roster comparison against this Match's confirmed attendees
 *   POST { sourceId, placements }  the reused teams as a PREVIEW (nothing saved or sent)
 * The Group comes from the URL only; a source of another Group or another Community is "not
 * found" (reuseTeams.reuseScopeWhere — checked on the server for every request).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

async function contextFor(params: Params) {
  const { matchId, ...slugs } = await params;
  return { context: await requireTenantContextForSlugs(slugs), matchId: typeof matchId === "string" ? matchId.slice(0, 64) : "" };
}

export async function GET(req: Request, { params }: { params: Params }) {
  try {
    const { context, matchId } = await contextFor(params);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const source = new URL(req.url).searchParams.get("source");
    return source ? await reusePlan(context, matchId, source.slice(0, 64)) : await reuseSources(context, matchId);
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
    return await buildReusedTeams(context, matchId, await req.json().catch(() => null));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
