import { prisma } from "@/lib/prisma";

export async function getTeamName(): Promise<string> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "TEAM_NAME" } });
    return row?.value?.trim() || (process.env.TEAM_NAME ?? "Your Team Name");
  } catch {
    // If DB is temporarily unavailable, fall back
    return process.env.TEAM_NAME ?? "Your Team Name";
  }
}
