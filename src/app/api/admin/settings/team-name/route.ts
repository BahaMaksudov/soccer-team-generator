import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { teamNameSchema, zodErrorResponse } from "@/lib/validation";

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value?.trim() || process.env.TEAM_NAME || "New England Eagles",
  });
}

async function saveTeamName(req: Request) {
  const body = await req.json().catch(() => ({}));

  const parsed = teamNameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const nextName = parsed.data.teamName;

  await prisma.appSetting.upsert({
    where: { key: "teamName" },
    update: { value: nextName },
    create: { key: "teamName", value: nextName },
  });

  // Helps Next refresh immediately after save (server components/pages)
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
