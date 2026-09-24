import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { playerUpdateSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const parsed = playerUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
    }

    // Ownership check before any mutation: a foreign-tenant id (or one
    // that simply doesn't exist) is indistinguishable from the caller's
    // point of view — both return a plain 404, never a 403 that would
    // confirm "this id exists, just not yours."
    const existing = await prisma.player.findFirst({
      where: { id, groupId: context.activeGroup.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
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
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  try {
    const { id } = await params;

    // Same ownership-first pattern as PATCH. The subsequent delete's
    // cascade behavior (TelegramUserLink.onDelete: Cascade, see
    // prisma/schema.prisma) is completely unchanged — this only gates
    // *whether* the existing delete runs, not what it does.
    const existing = await prisma.player.findFirst({
      where: { id, groupId: context.activeGroup.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }

    await prisma.player.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to delete player";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
