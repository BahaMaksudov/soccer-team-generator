import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { telegramImportSchema, zodErrorResponse } from "@/lib/validation";
import { isPlayingVote } from "@/lib/telegramFormat";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = telegramImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { pollId } = parsed.data;

  const answers = await prisma.telegramPollAnswer.findMany({
    where: { pollId },
    select: { userId: true, optionIdsJson: true },
  });

  const playingUserIds = answers
    .filter((a) => isPlayingVote(a.optionIdsJson))
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

  return NextResponse.json({ ok: true, selectedPlayerIds, missingUserIds });
}
