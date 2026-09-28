import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { playerCreateSchema, playerUpdateSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.1 — shared Player CRUD core, extracted verbatim from
 * the legacy /api/admin/players[/​[id]] route bodies (only the tenant
 * resolution step was removed — every remaining line of business
 * logic, validation, and Prisma call is unchanged). Both the legacy
 * flat routes (resolving via requireTenantContext()) and the new
 * canonical URL-bound routes (resolving via
 * requireTenantContextForSlugs()) delegate here after they've each
 * independently resolved and authorized their own TenantContext —
 * this module never resolves tenancy itself and never reads
 * request body/query parameters for ownership. It receives an
 * already-authorized `context.activeGroup.id` and uses nothing else
 * for scoping.
 */

export async function listPlayers(context: TenantContext): Promise<NextResponse> {
  const players = await prisma.player.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return NextResponse.json(players);
}

export async function createPlayer(context: TenantContext, req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => ({}));

  // playerCreateSchema has no `groupId` field and is not .passthrough(),
  // so a client-supplied body.groupId is stripped during parsing below
  // and never reaches this point — ownership is set exclusively from
  // context.activeGroup.id a few lines down.
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
        groupId: context.activeGroup.id,
      },
    });

    return NextResponse.json(created);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create player";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function updatePlayer(context: TenantContext, id: string, req: Request): Promise<NextResponse> {
  try {
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

export async function deletePlayer(context: TenantContext, id: string): Promise<NextResponse> {
  try {
    // Same ownership-first pattern as updatePlayer. The subsequent
    // delete's cascade behavior (TelegramUserLink.onDelete: Cascade,
    // see prisma/schema.prisma) is completely unchanged — this only
    // gates *whether* the existing delete runs, not what it does.
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
