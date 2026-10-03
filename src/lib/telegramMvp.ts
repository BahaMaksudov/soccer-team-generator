import type { Prisma } from "@prisma/client";
import { participantsOf } from "@/lib/matchParticipants";

/**
 * M9-D — Telegram adapter for the provider-neutral MVP vote (MatchMvpVote),
 * used by the webhook (live) and by "Close MVP vote" (replay of stored
 * answers). Attendance answers never reach here (poll kind decides).
 */
/**
 * Webhook + close-time replay: one Telegram answer of a Match's MVP poll →
 * the voter Player's ONE current vote. Unlinked voters, non-participants,
 * self-votes and malformed (multi-option / out-of-range) answers never count;
 * a retracted answer (or a switch to oneself) clears the current vote.
 */
export async function applyTelegramMvpAnswer(
  tx: Prisma.TransactionClient,
  input: { matchId: string; groupId: string; telegramUserId: bigint; optionIds: unknown; allowClosed?: boolean }
): Promise<"recorded" | "withdrawn" | "closed" | "unlinked" | "not_participant" | "self" | "invalid"> {
  const mvp = await tx.matchMvp.findFirst({ where: { matchId: input.matchId, groupId: input.groupId }, select: { candidatePlayerIds: true, openedAt: true, closedAt: true } });
  if (!mvp || !mvp.openedAt || (mvp.closedAt && !input.allowClosed)) return "closed";
  const link = await tx.telegramUserLink.findUnique({ where: { groupId_userId: { groupId: input.groupId, userId: input.telegramUserId } }, select: { playerId: true } });
  if (!link) return "unlinked";
  const gen = await tx.teamGeneration.findFirst({ where: { matchId: input.matchId, groupId: input.groupId }, select: { teamsJson: true } });
  const voter = participantsOf(gen?.teamsJson).find((p) => p.playerId === link.playerId);
  if (!voter) return "not_participant";
  const ids = Array.isArray(input.optionIds) ? input.optionIds : [];
  const clear = () => tx.matchMvpVote.deleteMany({ where: { matchId: input.matchId, groupId: input.groupId, voterPlayerId: voter.playerId } });
  if (ids.length === 0) {
    await clear();
    return "withdrawn";
  }
  const index = ids[0];
  if (ids.length !== 1 || !Number.isInteger(index) || index < 0 || index >= mvp.candidatePlayerIds.length) return "invalid";
  const candidate = mvp.candidatePlayerIds[index as number];
  if (candidate === voter.playerId) {
    await clear(); // the current selection is themselves → no official vote
    return "self";
  }
  await tx.matchMvpVote.upsert({
    where: { matchId_voterPlayerId: { matchId: input.matchId, voterPlayerId: voter.playerId } },
    update: { candidatePlayerId: candidate, source: "TELEGRAM" },
    create: { matchId: input.matchId, groupId: input.groupId, voterPlayerId: voter.playerId, candidatePlayerId: candidate, source: "TELEGRAM" },
  });
  return "recorded";
}
