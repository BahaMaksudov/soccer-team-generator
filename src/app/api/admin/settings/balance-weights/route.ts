import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { DEFAULT_BALANCE_WEIGHTS, mergeBalanceWeights } from "@/lib/scoring";
import { balanceWeightsSchema } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

const SETTING_KEY = "balanceWeights";

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

  // No GroupSetting yet for this Group -> application defaults. Never
  // fall back to the legacy global AppSetting.balanceWeights row or to
  // another Group's row — same no-cross-tenant-fallback policy already
  // established for teamName (Phase 2D.4).
  if (!row?.value) {
    return NextResponse.json({ weights: DEFAULT_BALANCE_WEIGHTS });
  }

  try {
    const parsed = JSON.parse(row.value);
    // mergeBalanceWeights never throws — malformed/legacy stored fields
    // (e.g. old fairnessWeights/optimizer keys) are safely ignored.
    return NextResponse.json({ weights: mergeBalanceWeights(parsed) });
  } catch {
    return NextResponse.json({ weights: DEFAULT_BALANCE_WEIGHTS });
  }
}

async function save(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const body = await req.json().catch(() => ({}));

  const parsed = balanceWeightsSchema.safeParse(body?.weights);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid weights.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Normalize through mergeBalanceWeights so only the known, currently
  // meaningful fields are ever persisted.
  const weights = mergeBalanceWeights(parsed.data);

  // Server determines group ownership — balanceWeightsSchema has no
  // groupId field and this route never reads body.groupId at all, so
  // a client-supplied groupId cannot redirect the write target.
  await prisma.groupSetting.upsert({
    where: { groupId_key: { groupId: context.activeGroup.id, key: SETTING_KEY } },
    update: { value: JSON.stringify(weights) },
    create: { groupId: context.activeGroup.id, key: SETTING_KEY, value: JSON.stringify(weights) },
  });

  revalidatePath("/admin");
  revalidatePath("/admin/settings");

  return NextResponse.json({ ok: true, weights });
}

export async function POST(req: Request) {
  return save(req);
}

export async function PUT(req: Request) {
  return save(req);
}
