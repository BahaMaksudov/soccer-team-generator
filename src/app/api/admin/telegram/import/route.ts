import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const pollId = String(body.pollId ?? "").trim();
  if (!pollId) return NextResponse.json({ error: "pollId is required" }, { status: 400 });

  // optionIdsJson stored like "[0]" etc.
  // We want only ✅ Playing = option index 0
  const answers = await prisma.telegramPollAnswer.findMany({
    where: { pollId },
    select: { userId: true, optionIdsJson: true },
  });

  const playingUserIds = answers
    .filter((a) => {
      try {
        const arr = JSON.parse(a.optionIdsJson || "[]");
        return Array.isArray(arr) && arr.includes(0);
      } catch {
        return false;
      }
    })
    .map((a) => a.userId);

  if (playingUserIds.length === 0) {
    return NextResponse.json({
      ok: true,
      selectedPlayerIds: [],
      missingUserIds: [],
      note: "No ✅ Playing votes found for that pollId.",
    });
  }

  const links = await prisma.telegramUserLink.findMany({
    where: { userId: { in: playingUserIds } },
    select: { userId: true, playerId: true },
  });

  const linkMap = new Map(links.map((l) => [l.userId.toString(), l.playerId]));
  const selectedPlayerIds: string[] = [];
  const missingUserIds: string[] = [];

  for (const uid of playingUserIds) {
    const pid = linkMap.get(uid.toString());
    if (pid) selectedPlayerIds.push(pid);
    else missingUserIds.push(uid.toString());
  }

  return NextResponse.json({
    ok: true,
    selectedPlayerIds,
    missingUserIds,
  });
}
