import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { DEFAULT_BALANCE_WEIGHTS, mergeBalanceWeights } from "@/lib/scoring";
import { balanceWeightsSchema } from "@/lib/validation";

const SETTING_KEY = "balanceWeights";

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });

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

  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: JSON.stringify(weights) },
    create: { key: SETTING_KEY, value: JSON.stringify(weights) },
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
