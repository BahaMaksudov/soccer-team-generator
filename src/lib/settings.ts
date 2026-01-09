// import { prisma } from "@/lib/prisma";

// export async function getTeamName(): Promise<string> {
//   try {
//     const row = await prisma.appSetting.findUnique({ where: { key: "TEAM_NAME" } });
//     return row?.value?.trim() || (process.env.TEAM_NAME ?? "Your Team Name");
//   } catch {
//     // If DB is temporarily unavailable, fall back
//     return process.env.TEAM_NAME ?? "Your Team Name";
//   }
// }

import { prisma } from "@/lib/prisma";
import { unstable_noStore as noStore } from "next/cache";

export async function getTeamName(): Promise<string> {
  noStore(); // ✅ prevents Next from caching this DB read

  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "teamName" } }); // ✅ SAME KEY
    return row?.value?.trim() || (process.env.TEAM_NAME ?? "Your Team Name");
  } catch {
    return process.env.TEAM_NAME ?? "Your Team Name";
  }
}
