import type { BalanceAnalysis, BalanceQuality } from "@/lib/balanceAnalysis";

/**
 * M8-A — pure display helpers for the organizer's Balance Intelligence
 * panel (admin only; nothing here is ever rendered on public pages).
 */

export const QUALITY_LABEL: Record<BalanceQuality, string> = { EVEN: "Even", CLOSE: "Close", UNEVEN: "Uneven" };

export type SwapDisplay = { nameA: string; teamA: number; nameB: string; teamB: number; from: string; to: string };

type NamedTeam = { teamNumber: number; players: Array<{ id: string; firstName?: string; lastName?: string }> };

/** Names for the suggested swap, resolved from the preview teams the organizer already sees. */
export function describeSwap(analysis: Pick<BalanceAnalysis, "bestSwap">, teams: NamedTeam[]): SwapDisplay | null {
  const s = analysis.bestSwap;
  if (!s) return null;
  const name = (id: string) => {
    for (const t of teams) {
      const p = t.players.find((x) => x.id === id);
      if (p) return `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Player";
    }
    return null;
  };
  const nameA = name(s.playerA);
  const nameB = name(s.playerB);
  if (!nameA || !nameB) return null;
  return { nameA, teamA: s.teamA, nameB, teamB: s.teamB, from: QUALITY_LABEL[s.before.quality], to: QUALITY_LABEL[s.after.quality] };
}

/** Request body for POST …/generate/swap: membership and the chosen swap only. */
export function applySwapBody(teams: NamedTeam[], analysis: Pick<BalanceAnalysis, "bestSwap">) {
  return {
    teams: teams.map((t) => ({ teamNumber: t.teamNumber, playerIds: t.players.map((p) => p.id) })),
    swap: { playerA: analysis.bestSwap?.playerA ?? "", playerB: analysis.bestSwap?.playerB ?? "" },
  };
}
