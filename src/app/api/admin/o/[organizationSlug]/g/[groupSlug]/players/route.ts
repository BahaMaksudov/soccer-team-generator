import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse } from "@/lib/tenantRoute";
import { listPlayers, createPlayer } from "@/lib/playerCrud";

/**
 * Phase 2D.6D.1 — canonical, URL-bound Players collection route.
 * Tenant identity comes exclusively from the URL's
 * (organizationSlug, groupSlug) pair, resolved and authorized fresh
 * on every request via requireTenantContextForSlugs() — the URL is
 * selection input, never authorization proof (Phase 2D.6B/2D.6C).
 * Business logic lives in src/lib/playerCrud.ts — nothing here
 * reimplements Player CRUD.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return listPlayers(context);
}

export async function POST(req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  let context;
  try {
    context = await requireTenantContextForSlugs({ organizationSlug, groupSlug });
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }

  return createPlayer(context, req);
}
