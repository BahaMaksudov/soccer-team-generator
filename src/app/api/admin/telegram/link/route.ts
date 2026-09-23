import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { telegramLinkSchema, zodErrorResponse } from "@/lib/validation";

export async function POST(req: Request) {
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

  // ensure player exists
  const player = await prisma.player.findUnique({ where: { id: playerIdStr } });
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  await prisma.telegramUserLink.upsert({
    where: { userId },
    update: { playerId: playerIdStr },
    create: { userId, playerId: playerIdStr },
  });

  return NextResponse.json({ ok: true });
}
