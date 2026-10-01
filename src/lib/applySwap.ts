import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySwapSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";
import { evaluateTeams, resolveBalanceConfig } from "@/lib/balanceEngine";
import { analyzeTeams, applySwap, METRICS_VERSION } from "@/lib/balanceAnalysis";
import { findSport } from "@/lib/sports";
import { loadStoredBalanceWeights } from "@/lib/groupSettings";

/**
 * M8-A — apply the deterministic best-swap suggestion to the organizer's
 * PREVIEW. Nothing is persisted, published or sent: the response is the
 * swapped teams plus fresh metrics/analysis for the client to show.
 *
 * Trust boundary: the client supplies only team membership (player ids)
 * and the swap it wants. The server re-reads the Players (scoped to the
 * URL-resolved Group — foreign or unknown ids fail with the same generic
 * message as Publish), the Group's sport and balance settings, recomputes
 * the analysis, and applies the swap ONLY if it is exactly the current
 * deterministic suggestion; otherwise 409 with the fresh analysis.
 */

const INVALID_PLAYERS_MESSAGE = "One or more players are invalid or unavailable.";
const PREVIEW_PLAYER_SELECT = { id: true, firstName: true, lastName: true, position: true, rating: true, stamina: true } as const;

export async function applySuggestedSwapForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const parsed = applySwapSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const sport = findSport(context.activeGroup.sportKey);
  if (!sport) return NextResponse.json({ error: "This group's sport is not supported." }, { status: 400 });

  const { teams: submitted, swap } = parsed.data;
  const ids = submitted.flatMap((t) => t.playerIds);
  if (new Set(ids).size !== ids.length || new Set(submitted.map((t) => t.teamNumber)).size !== submitted.length) {
    return NextResponse.json({ error: INVALID_PLAYERS_MESSAGE }, { status: 400 });
  }

  const owned = await prisma.player.findMany({
    where: { id: { in: ids }, groupId: context.activeGroup.id },
    select: PREVIEW_PLAYER_SELECT,
  });
  if (owned.length !== ids.length) return NextResponse.json({ error: INVALID_PLAYERS_MESSAGE }, { status: 400 });

  const byId = new Map(owned.map((p) => [p.id, p]));
  const teams = submitted.map((t) => ({ teamNumber: t.teamNumber, players: t.playerIds.map((id) => byId.get(id)!) }));
  const config = resolveBalanceConfig(sport, await loadStoredBalanceWeights(context.activeGroup.id));
  const current = analyzeTeams(sport, config, teams);

  const s = current.bestSwap;
  const requested = new Set([swap.playerA, swap.playerB]);
  if (!s || requested.size !== 2 || !requested.has(s.playerA) || !requested.has(s.playerB)) {
    return NextResponse.json(
      { error: "This suggestion is no longer current. Review the latest balance suggestion.", metrics: { metricsVersion: METRICS_VERSION, ...evaluateTeams(sport, config, teams) }, analysis: current },
      { status: 409 }
    );
  }

  const swapped = applySwap(teams, s.playerA, s.playerB)!;
  return NextResponse.json({
    teams: swapped,
    metrics: { metricsVersion: METRICS_VERSION, ...evaluateTeams(sport, config, swapped) },
    analysis: analyzeTeams(sport, config, swapped),
  });
}
