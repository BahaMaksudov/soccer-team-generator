import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { teamNameSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

const SETTING_KEY = "teamName";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const row = await prisma.groupSetting.findUnique({
    where: { groupId_key: { groupId: context.activeGroup.id, key: SETTING_KEY } },
  });

  // No cross-tenant/global fallback: a Group that hasn't set a custom
  // team name yet gets an empty value, not another tenant's name and
  // not the legacy global AppSetting row. The Admin UI already treats
  // an empty teamName as "nothing saved yet" (see TeamSettings.tsx).
  return NextResponse.json({
    teamName: row?.value?.trim() || "",
  });
}

async function saveTeamName(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const body = await req.json().catch(() => ({}));

  const parsed = teamNameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const nextName = parsed.data.teamName;

  // Server determines group ownership — groupId is never accepted
  // from the client (teamNameSchema has no such field, so any
  // client-supplied groupId/organizationId is structurally stripped
  // by safeParse before reaching here).
  await prisma.groupSetting.upsert({
    where: { groupId_key: { groupId: context.activeGroup.id, key: SETTING_KEY } },
    update: { value: nextName },
    create: { groupId: context.activeGroup.id, key: SETTING_KEY, value: nextName },
  });

  // Never write AppSetting.teamName here — GroupSetting is the sole
  // authoritative source for authenticated Admin settings as of
  // Phase 2D.4. AppSetting remains for legacy/public reads only,
  // deliberately not kept in sync (see Phase 2D.4 report §J).
  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");
  revalidatePath("/players", "layout");

  return NextResponse.json({ ok: true, teamName: nextName });
}

// Admin UI calls both POST and PUT historically — keep both working.
export async function POST(req: Request) {
  return saveTeamName(req);
}

export async function PUT(req: Request) {
  return saveTeamName(req);
}
