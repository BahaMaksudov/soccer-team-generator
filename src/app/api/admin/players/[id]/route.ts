import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json();

    // ✅ stamina: only update if provided; clamp to 1..5
    let stamina: number | undefined = undefined;
    if (body.stamina !== undefined) {
      const raw = Number(body.stamina);
      stamina = Number.isFinite(raw) ? Math.min(5, Math.max(1, raw)) : 3;
    }

    const updated = await prisma.player.update({
      where: { id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        position: body.position,
        rating: body.rating,
        stamina: typeof body.stamina === "number" ? body.stamina : undefined, // ✅ NEW
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to update player" },
      { status: 400 }
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;

    await prisma.player.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Failed to delete player" },
      { status: 400 }
    );
  }
}
