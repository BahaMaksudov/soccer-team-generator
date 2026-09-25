import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePublicGroup } from "@/lib/publicGroup";

/**
 * Phase 2D.5D — canonical, tenant-scoped public teamName.
 *
 * Read-only. Tenant identity comes only from the URL's two slug
 * segments via resolvePublicGroup() — same resolver, same trust
 * model as the canonical Players API (Phase 2D.5C). teamName is
 * sourced exclusively from GroupSetting (groupId_key selector,
 * already verified in Phase 2D.4) — never AppSetting, never another
 * Group. Missing GroupSetting -> "" (same no-fallback policy
 * established for the authenticated Admin route in Phase 2D.4 §I).
 */

const SETTING_KEY = "teamName";

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const publicGroup = await resolvePublicGroup({ organizationSlug, groupSlug }, prisma);
  if (!publicGroup) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = await prisma.groupSetting.findUnique({
    where: { groupId_key: { groupId: publicGroup.group.id, key: SETTING_KEY } },
  });

  return NextResponse.json({
    teamName: row?.value?.trim() || "",
  });
}
