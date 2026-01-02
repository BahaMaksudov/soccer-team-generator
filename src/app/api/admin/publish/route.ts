import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";

export async function POST(req: Request) {
  const body = await req.json();

  const dateStr = String(body.date ?? "");
  const teams = body.teams;

  if (!dateStr) return NextResponse.json({ error: "Date is required." }, { status: 400 });
  if (!Array.isArray(teams) || teams.length === 0) return NextResponse.json({ error: "Teams are required." }, { status: 400 });

  const normalizedDate = toDateOnlyUTC(dateStr);

  const saved = await prisma.teamGeneration.upsert({
    where: { date: normalizedDate },
    create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
    update: { teamsJson: JSON.stringify(teams) },
  });

  return NextResponse.json({ ok: true, id: saved.id });
}
