import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: "TEAM_NAME" } });
  return NextResponse.json({ teamName: row?.value ?? "" });
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
    where: { key: "TEAM_NAME" },
    create: { key: "TEAM_NAME", value: teamName },
    update: { value: teamName },
  });

  return NextResponse.json({ ok: true, teamName });
}
