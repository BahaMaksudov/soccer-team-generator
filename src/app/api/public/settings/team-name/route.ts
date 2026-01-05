import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const KEY = "TEAM_NAME";

// export async function GET() {
//   const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
//   return NextResponse.json({ teamName: row?.value ?? "" });
// }

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value?.trim() || process.env.TEAM_NAME || "New England Eagles",
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const teamName = String(body?.teamName ?? "").trim();

  if (!teamName) {
    return NextResponse.json({ error: "Team name is required" }, { status: 400 });
  }
  if (teamName.length > 80) {
    return NextResponse.json({ error: "Team name too long (max 80 chars)" }, { status: 400 });
  }

  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: teamName },
    update: { value: teamName },
  });

  return NextResponse.json({ ok: true, teamName });
}
