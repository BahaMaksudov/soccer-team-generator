import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createOrganizationWorkspace, createWorkspaceSchema } from "@/lib/workspaces";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M5 — create an Organization + first Group for the signed-in User, who
 * becomes its OWNER. Used by first-time onboarding and by "Create
 * organization" from /admin. The owner is the session User; any
 * userId/organizationId/role in the body is ignored (stripped by the
 * schema).
 */
export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const user = await requireSessionUser();
    const parsed = createWorkspaceSchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

    const workspace = await createOrganizationWorkspace(user.id, parsed.data);
    return NextResponse.json(
      { ok: true, href: workspace.href, organization: workspace.organization, group: workspace.group },
      { status: workspace.replayed ? 200 : 201 }
    );
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
