import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  // distinct Telegram users who ever voted in any poll
  const users = await prisma.telegramPollAnswer.findMany({
    distinct: ["userId"],
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  // already-linked telegram users
  const linked = await prisma.telegramUserLink.findMany({
    select: { userId: true },
  });

  const linkedSet = new Set(linked.map((l) => l.userId.toString()));

  // ✅ BigInt -> string so JSON works
  const unlinked = users
    .filter((u) => !linkedSet.has(u.userId.toString()))
    .map((u) => ({
      userId: u.userId.toString(),
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
    }));

  return NextResponse.json(unlinked);
}
