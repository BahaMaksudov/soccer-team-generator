import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { playerCreateSchema, zodErrorResponse } from "@/lib/validation";

export async function GET() {
  const players = await prisma.player.findMany({
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return NextResponse.json(players);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const parsed = playerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { firstName, lastName, position, rating, isActive } = parsed.data;
  const stamina = parsed.data.stamina ?? 3;

  try {
    const created = await prisma.player.create({
      data: {
        firstName,
        lastName,
        position,
        rating,
        stamina,
        isActive: isActive ?? true,
      },
    });

    return NextResponse.json(created);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create player";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
