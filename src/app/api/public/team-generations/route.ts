import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const pageSize = Math.min(20, Math.max(1, Number(searchParams.get("pageSize") ?? "4")));

  const total = await prisma.teamGeneration.count();
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  const rows = await prisma.teamGeneration.findMany({
    orderBy: { date: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return NextResponse.json({
    page,
    totalPages,
    items: rows.map((r) => ({
      id: r.id,
      date: r.date,
      updatedAt: r.updatedAt,
      teams: JSON.parse(r.teamsJson),
    })),
  });
}