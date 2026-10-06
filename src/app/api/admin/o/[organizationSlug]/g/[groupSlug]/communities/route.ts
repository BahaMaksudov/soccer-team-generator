import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createCommunity, listCommunities } from "@/lib/communities";

/**
 * M9.2 — the Group's Communities (rosters). GET: any member of the Group
 * (names + memberships; managers also see attached Telegram chats).
 * POST: create (OWNER/ADMIN; MEMBER → 404).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  try {
    return await listCommunities(await requireTenantContextForSlugs(await params));
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    return await createCommunity(await requireTenantContextForSlugs(await params), req);
  } catch (e) {
    return canonicalTenantErrorResponse(e);
  }
}
