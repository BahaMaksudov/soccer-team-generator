import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { telegramLinkSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = telegramLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { userId: userIdStr, playerId: playerIdStr } = parsed.data;

  let userId: bigint;
  try {
    userId = BigInt(userIdStr);
  } catch {
    return NextResponse.json({ error: "userId must be a valid Telegram numeric id" }, { status: 400 });
  }

  // Ownership check: the target Player must belong to the caller's
  // active Group — previously this was a plain global findUnique, so
  // Group A could link a Telegram identity to Group B's Player.
  const player = await prisma.player.findFirst({
    where: { id: playerIdStr, groupId: activeGroupId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  // TelegramUserLink.userId is still a single, globally-unique column
  // (see Phase 2D.3 report §M — a genuine future multi-tenant
  // limitation, not a security hole, and not a schema change made
  // here). Because of that, this can't be a single atomic tenant-aware
  // upsert the way Publish's (groupId, date) key now is: we must check
  // first whether this Telegram identity is already linked under a
  // DIFFERENT Group, and refuse to silently reassign it — a client
  // must never be able to steal another tenant's existing link by
  // reusing its Telegram userId.
  const existingLink = await prisma.telegramUserLink.findUnique({ where: { userId } });
  if (existingLink && existingLink.groupId !== activeGroupId) {
    return NextResponse.json(
      { error: "This Telegram user is already linked elsewhere." },
      { status: 409 }
    );
  }

  await prisma.telegramUserLink.upsert({
    where: { userId },
    update: { playerId: playerIdStr, groupId: activeGroupId },
    create: { userId, playerId: playerIdStr, groupId: activeGroupId },
  });

  return NextResponse.json({ ok: true });
}
