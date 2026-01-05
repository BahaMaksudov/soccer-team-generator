import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value || "New England Rev",
  });
}
