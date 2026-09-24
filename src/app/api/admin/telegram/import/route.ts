import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { telegramImportSchema, zodErrorResponse } from "@/lib/validation";
import { isPlayingVote } from "@/lib/telegramFormat";
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

  const parsed = telegramImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { pollId } = parsed.data;

  // The poll being imported must belong to the caller's active Group.
  // Previously any pollId was accepted, which let one tenant discover
  // another tenant's voters/players by importing a foreign pollId.
  // 404, not 403 — never reveal that a foreign poll exists.
  const poll = await prisma.telegramPoll.findFirst({
    where: { pollId, groupId: activeGroupId },
    select: { pollId: true },
  });
  if (!poll) {
    return NextResponse.json({ error: "Poll not found" }, { status: 404 });
  }

  // Explicitly constrained by groupId too, not just pollId — defense
  // in depth rather than relying solely on the poll-ownership check
  // above plus the Answer.groupId == Poll.groupId invariant.
  const answers = await prisma.telegramPollAnswer.findMany({
    where: { pollId, groupId: activeGroupId },
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

  // Same defense-in-depth principle: only links belonging to the
  // active Group can resolve a Telegram voter to a Player.
  const links = await prisma.telegramUserLink.findMany({
    where: { userId: { in: playingUserIds }, groupId: activeGroupId },
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
