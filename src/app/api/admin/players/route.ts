import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Position, Rating } from "@prisma/client";

export async function GET() {
  const players = await prisma.player.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return NextResponse.json(players);
}

export async function POST(req: Request) {
  const body = await req.json();

  console.log("SERVER POST /players body.stamina =", body.stamina);

  const firstName = String(body.firstName ?? "").trim();
  const lastName = String(body.lastName ?? "").trim();

  if (!firstName || !lastName) {
    return NextResponse.json({ error: "First and last name are required." }, { status: 400 });
  }

  // ✅ stamina: default 3, clamp to 1..5
  const rawStamina = Number(body.stamina ?? 3);
  const stamina = Number.isFinite(rawStamina) ? Math.min(5, Math.max(1, rawStamina)) : 3;

  console.log("SERVER computed stamina =", stamina);

  const created = await prisma.player.create({
    data: {
      firstName,
      lastName,
      position: body.position as Position,
      rating: body.rating as Rating,
      stamina, // ✅ NEW
      isActive: Boolean(body.isActive ?? true),
    },
  });

  console.log("SERVER created.stamina =", created.stamina);

  return NextResponse.json(created);
}
