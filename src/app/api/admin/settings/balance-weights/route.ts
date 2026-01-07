import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

import { revalidatePath } from "next/cache";

const DEFAULT_WEIGHTS = {

  // player impact = ratingWeight + staminaCoef*stamina

  staminaCoef: 0.5,

  // role weights by position

  positionWeights: {

    GOALKEEPER: 1.0,

    DEFENDER: 1.05,

    MIDFIELDER: 1.15,

    FORWARD: 1.1,

  },

  // fairness weights (how important each category is)

  fairnessWeights: {

    totalImpact: 3.0,

    gkImpact: 2.0,

    defImpact: 1.5,

    midImpact: 1.5,

    fwdImpact: 1.5,

    topCount: 1.0,

  },

  // optimizer settings

  optimizer: {

    iterations: 400, // try 200–800 if you want

    samePositionSwapBias: 0.7, // prefer swapping same positions

  },

};

export async function GET() {

  const row = await prisma.appSetting.findUnique({ where: { key: "balanceWeights" } });

  if (!row?.value) {

    return NextResponse.json({ weights: DEFAULT_WEIGHTS });

  }

  try {

    const parsed = JSON.parse(row.value);

    // merge with defaults so missing keys don’t break

    const weights = {

      ...DEFAULT_WEIGHTS,

      ...parsed,

      positionWeights: { ...DEFAULT_WEIGHTS.positionWeights, ...(parsed.positionWeights ?? {}) },

      fairnessWeights: { ...DEFAULT_WEIGHTS.fairnessWeights, ...(parsed.fairnessWeights ?? {}) },

      optimizer: { ...DEFAULT_WEIGHTS.optimizer, ...(parsed.optimizer ?? {}) },

    };

    return NextResponse.json({ weights });

  } catch {

    return NextResponse.json({ weights: DEFAULT_WEIGHTS });

  }

}

async function save(req: Request) {

  const body = await req.json().catch(() => ({}));

  const weights = body?.weights;

  if (!weights || typeof weights !== "object") {

    return NextResponse.json({ error: "weights is required" }, { status: 400 });

  }

  await prisma.appSetting.upsert({

    where: { key: "balanceWeights" },

    update: { value: JSON.stringify(weights) },

    create: { key: "balanceWeights", value: JSON.stringify(weights) },

  });

  // refresh admin pages

  revalidatePath("/admin");

  revalidatePath("/admin/settings");

  return NextResponse.json({ ok: true });

}

export async function POST(req: Request) {

  return save(req);

}

export async function PUT(req: Request) {

  return save(req);

}
 