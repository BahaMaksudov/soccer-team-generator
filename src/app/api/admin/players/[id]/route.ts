import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Position, Rating } from "@prisma/client";

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const body = await req.json();

  const updated = await prisma.player.update({
    where: { id: ctx.params.id },
    data: {
      firstName: body.firstName !== undefined ? String(body.firstName).trim() : undefined,
      lastName: body.lastName !== undefined ? String(body.lastName).trim() : undefined,
      position: body.position !== undefined ? (body.position as Position) : undefined,
      rating: body.rating !== undefined ? (body.rating as Rating) : undefined,
      isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  await prisma.player.delete({ where: { id: ctx.params.id } });
  return NextResponse.json({ ok: true });
}
