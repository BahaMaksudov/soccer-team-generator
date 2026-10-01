import { NextResponse } from "next/server";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createGroupInOrganization, createGroupSchema } from "@/lib/workspaces";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M7 — "Add Group" to the URL-selected Organization (OWNER/ADMIN). The
 * Organization comes only from the membership-verified context; MEMBERs,
 * non-members and unknown Organizations all get the same generic 404.
 * The sport must be a registry key and is immutable after creation.
 */
type Params = Promise<{ organizationSlug: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const context = await requireOrganizationContextForSlug(await params);
    const parsed = createGroupSchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

    const created = await createGroupInOrganization(context, parsed.data);
    return NextResponse.json({ ok: true, href: created.href, group: created.group }, { status: created.replayed ? 200 : 201 });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
