import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { updatePlayer, deletePlayer } from "@/lib/playerCrud";

/**
 * Phase 2D.6D.1 — canonical, URL-bound Player resource route.
 * Ownership is enforced inside updatePlayer()/deletePlayer()
 * (src/lib/playerCrud.ts) via `findFirst({ id, groupId: context.
 * activeGroup.id })` before any mutation — a foreign-Group player id
 * is indistinguishable from a nonexistent one (generic 404), and the
 * update/delete call never runs when ownership fails. Tenant identity
 * here comes exclusively from the URL's (organizationSlug, groupSlug)
 * pair.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string; id: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug, id } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return updatePlayer(context, id, req);
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug, id } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return deletePlayer(context, id);
}
