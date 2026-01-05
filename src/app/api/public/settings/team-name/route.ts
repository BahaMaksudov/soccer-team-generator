import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic"; // important on Vercel

export async function GET() {
  const row = await prisma.appSetting.findUnique({
    where: { key: "teamName" },
  });

  return NextResponse.json({
    teamName: row?.value ?? "New England Eagles", // or "Soccer Team Generator"
  });
}
