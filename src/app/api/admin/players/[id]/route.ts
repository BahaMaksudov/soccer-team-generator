import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { playerUpdateSchema, zodErrorResponse } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const parsed = playerUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
    }

    const { firstName, lastName, position, rating, stamina, isActive } = parsed.data;

    const updated = await prisma.player.update({
      where: { id },
      data: { firstName, lastName, position, rating, stamina, isActive },
    });

    return NextResponse.json(updated);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to update player";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;

    await prisma.player.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to delete player";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
