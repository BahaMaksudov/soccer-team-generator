import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const userIdStr = String(body.userId ?? "");
  const playerIdStr = String(body.playerId ?? "");

  if (!userIdStr || !playerIdStr) {
    return NextResponse.json({ error: "userId and playerId are required" }, { status: 400 });
  }

  const userId = BigInt(userIdStr);

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
