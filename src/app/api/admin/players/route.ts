import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Position, Rating } from "@prisma/client";

export async function GET() {
  const players = await prisma.player.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
  return NextResponse.json(players);
}

export async function POST(req: Request) {
  const body = await req.json();
  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();
  if (!firstName || !lastName) return NextResponse.json({ error: "First and last name are required." }, { status: 400 });

  const created = await prisma.player.create({
    data: {
      firstName,
      lastName,
      position: body.position as Position,
      rating: body.rating as Rating,
      isActive: Boolean(body.isActive ?? true),
    },
  });
  return NextResponse.json(created);
}
