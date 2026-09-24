import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { playerCreateSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const players = await prisma.player.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return NextResponse.json(players);
}

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

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
