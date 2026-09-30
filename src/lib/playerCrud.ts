import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { playerCreateSchema, playerUpdateSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.1 — shared Player CRUD core, extracted verbatim from
 * the legacy /api/admin/players[/​[id]] route bodies (only the tenant
 * resolution step was removed — every remaining line of business
 * logic, validation, and Prisma call is unchanged). The canonical
 * URL-bound routes (resolving via requireTenantContextForSlugs())
 * delegate here after resolving and authorizing their TenantContext
 * (the legacy flat routes were deleted in Phase 2D.6D.5E.5) — this
 * module never resolves tenancy itself and never reads
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
    // Phase 2D.6E.6C — never return raw database/Prisma messages.
    console.error("createPlayer failed", e);
    return NextResponse.json({ error: "Failed to create player" }, { status: 500 });
  }
}

export async function updatePlayer(context: TenantContext, id: string, req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => ({}));

  const parsed = playerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const groupId = context.activeGroup.id;
  const { firstName, lastName, position, rating, stamina, isActive } = parsed.data;
  const data = { firstName, lastName, position, rating, stamina, isActive };
  const hasChanges = Object.values(data).some((v) => v !== undefined);

  try {
    // Phase 2D.6E.6C — the tenant boundary is the mutation itself: one
    // statement scoped by BOTH id and the URL-resolved Group, never a
    // separate ownership check followed by a write by globally unique id.
    // A foreign-Group id and a nonexistent id both affect 0 rows and are
    // indistinguishable (plain 404, never 403).
    if (hasChanges) {
      const result = await prisma.player.updateMany({ where: { id, groupId }, data });
      if (result.count !== 1) {
        return NextResponse.json({ error: "Player not found" }, { status: 404 });
      }
    }

    // Read back the Group-scoped row (never by id alone).
    const updated = await prisma.player.findFirst({ where: { id, groupId } });
    if (!updated) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (e: unknown) {
    console.error("updatePlayer failed", e);
    return NextResponse.json({ error: "Failed to update player" }, { status: 500 });
  }
}

export async function deletePlayer(context: TenantContext, id: string): Promise<NextResponse> {
  try {
    // Phase 2D.6E.6C — single Group-scoped delete: the mutation itself
    // carries id AND the URL-resolved groupId. 0 rows (foreign or
    // nonexistent) → 404. The cascade to TelegramUserLink (onDelete:
    // Cascade, see prisma/schema.prisma) is unchanged.
    const result = await prisma.player.deleteMany({ where: { id, groupId: context.activeGroup.id } });
    if (result.count !== 1) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("deletePlayer failed", e);
    return NextResponse.json({ error: "Failed to delete player" }, { status: 500 });
  }
}
