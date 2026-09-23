import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Read-only. The equivalent protected write path is
// /api/admin/settings/team-name (session-gated by middleware.ts).
//
// This route previously also exposed an unauthenticated PUT that let
// any caller rename the team/group — removed. Public callers may only
// ever read this value, never change it.

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value?.trim() || process.env.TEAM_NAME || "New England Eagles",
  });
}
