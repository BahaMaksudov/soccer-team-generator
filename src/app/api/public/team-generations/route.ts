import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const pageSize = Math.min(20, Math.max(1, Number(searchParams.get("pageSize") ?? "4")));

  const total = await prisma.teamGeneration.count();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const skip = (page - 1) * pageSize;

  const items = await prisma.teamGeneration.findMany({
    orderBy: [{ date: "desc" }],
    skip,
    take: pageSize,
  });

  const mapped = items.map((g) => ({
    id: g.id,
    date: g.date.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    teams: JSON.parse(g.teamsJson),
  }));

  return NextResponse.json({ page, totalPages, items: mapped });
}
