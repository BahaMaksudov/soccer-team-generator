import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { confirmedAttendeeIds } from "@/lib/attendanceSnapshot";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { playerDisplayName } from "@/lib/playerFacing";
import { evaluateTeams, resolveBalanceConfig } from "@/lib/balanceEngine";
import { analyzeTeams, METRICS_VERSION } from "@/lib/balanceAnalysis";
import { findSport } from "@/lib/sports";
import { loadStoredBalanceWeights } from "@/lib/groupSettings";
import { assignShirtColors, isShirtColorId, type ShirtColorId } from "@/lib/shirtColors";

/**
 * Reuse previous teams for a Match.
 *
 * Source: an earlier PUBLISHED TeamGeneration of the SAME Group (never another Group's or
 * Organization's; never this Match's own). The source row is only read — never modified.
 *
 * Reconciliation is by stable Player id only (never by name) against this Match's CONFIRMED
 * attendees (attendanceSnapshot.confirmedAttendeeIds — the authoritative Generate-from-Match rule):
 *   returning   on the previous teams AND confirmed now → keep their previous team, in order;
 *   absent      on the previous teams, NOT confirmed now → left out (never silently re-added);
 *   unassigned  confirmed now, NOT on the previous teams → listed; the organizer MUST place each
 *               one on a team before the teams are built (never silently omitted).
 * Team numbers and saved shirt colors carry over (older publications without colors get the
 * default order). Balance is never changed automatically: the result carries the usual analysis
 * (quality, roster notes, the suggested swap) and the organizer decides.
 */

export type SourceTeam = { teamNumber: number; shirtColor?: unknown; players: Array<{ id: string; firstName?: string; lastName?: string }> };

/** Pure: split a previous publication against the current confirmed attendees. */
export function reconcileReuse(sourceTeams: readonly SourceTeam[], confirmedIds: readonly string[]) {
  const confirmed = new Set(confirmedIds);
  const seen = new Set<string>();
  const teams = [...sourceTeams]
    .sort((a, b) => a.teamNumber - b.teamNumber)
    .map((t) => ({
      teamNumber: t.teamNumber,
      shirtColor: isShirtColorId(t.shirtColor) ? t.shirtColor : null,
      playerIds: t.players
        .map((p) => p.id)
        .filter((id) => {
          if (typeof id !== "string" || seen.has(id)) return false; // a malformed duplicate never appears twice
          seen.add(id);
          return confirmed.has(id);
        }),
    }));
  const absent = sourceTeams
    .flatMap((t) => t.players.map((p) => ({ id: p.id, name: playerDisplayName(p), teamNumber: t.teamNumber })))
    .filter((p, i, all) => typeof p.id === "string" && !confirmed.has(p.id) && all.findIndex((q) => q.id === p.id) === i);
  const onTeams = new Set(teams.flatMap((t) => t.playerIds));
  const unassignedIds = [...confirmed].filter((id) => !onTeams.has(id));
  return { teams, absent, unassignedIds };
}

/** Pure: apply the organizer's placements. Every unassigned attendee exactly once, onto an existing team. */
export function applyPlacements(teams: ReadonlyArray<{ teamNumber: number; shirtColor: ShirtColorId | null; playerIds: string[] }>, unassignedIds: readonly string[], placements: Record<string, unknown>):
  | { ok: true; teams: Array<{ teamNumber: number; shirtColor: ShirtColorId | null; playerIds: string[] }> }
  | { ok: false; error: string } {
  const numbers = new Set(teams.map((t) => t.teamNumber));
  const keys = Object.keys(placements);
  const expected = new Set(unassignedIds);
  if (keys.some((k) => !expected.has(k))) return { ok: false, error: "Only players who are new to these teams can be placed." };
  const missing = unassignedIds.filter((id) => !(id in placements));
  if (missing.length > 0) return { ok: false, error: "Place every confirmed player on a team before using these teams." };
  const out = teams.map((t) => ({ ...t, playerIds: [...t.playerIds] }));
  for (const id of unassignedIds) {
    const n = placements[id];
    if (typeof n !== "number" || !numbers.has(n)) return { ok: false, error: "Choose one of the existing teams for each new player." };
    out.find((t) => t.teamNumber === n)!.playerIds.push(id);
  }
  const empty = out.filter((t) => t.playerIds.length === 0).map((t) => `Team #${t.teamNumber}`);
  if (empty.length > 0) return { ok: false, error: `${empty.join(", ")} would have no players. Place someone there, or generate new teams instead.` };
  const all = out.flatMap((t) => t.playerIds);
  if (new Set(all).size !== all.length) return { ok: false, error: "A player can only be on one team." };
  return { ok: true, teams: out };
}

const notFound = () => NextResponse.json({ error: "Match not found" }, { status: 404 });
const MATCH_PLAYER_SELECT = { id: true, firstName: true, lastName: true, position: true, rating: true, stamina: true } as const;

function parseTeams(teamsJson: string): SourceTeam[] {
  try {
    const parsed = JSON.parse(teamsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((t: unknown) => {
      const team = t as { teamNumber?: unknown; shirtColor?: unknown; players?: unknown };
      if (!team || typeof team.teamNumber !== "number" || !Array.isArray(team.players)) return [];
      const players = team.players.flatMap((p: unknown) => {
        const pl = p as { id?: unknown; firstName?: unknown; lastName?: unknown };
        return pl && typeof pl.id === "string" ? [{ id: pl.id, firstName: typeof pl.firstName === "string" ? pl.firstName : "", lastName: typeof pl.lastName === "string" ? pl.lastName : "" }] : [];
      });
      return [{ teamNumber: team.teamNumber, shirtColor: team.shirtColor, players }];
    });
  } catch {
    return [];
  }
}

async function loadMatch(context: TenantContext, matchId: string) {
  return prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: { id: true, date: true } });
}

/** The Group's earlier publications (newest first), excluding this Match's own teams. */
export async function reuseSources(context: TenantContext, matchId: string): Promise<NextResponse> {
  const match = await loadMatch(context, matchId);
  if (!match) return notFound();
  const rows = await prisma.teamGeneration.findMany({
    where: { groupId: context.activeGroup.id, NOT: { matchId } },
    orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
    take: 30,
    select: { id: true, date: true, teamsJson: true, match: { select: { startTime: true, locationName: true } } },
  });
  const sources = rows
    .map((r) => {
      const teams = parseTeams(r.teamsJson);
      return {
        id: r.id,
        date: formatYMDFromDate(r.date),
        startTime: r.match?.startTime ?? null,
        locationName: r.match?.locationName ?? null,
        teamCount: teams.length,
        playerCount: teams.reduce((n, t) => n + t.players.length, 0),
        hasShirtColors: teams.some((t) => isShirtColorId(t.shirtColor)),
      };
    })
    .filter((s) => s.teamCount > 0);
  return NextResponse.json({ sources }, { headers: { "Cache-Control": "no-store" } });
}

async function loadSourceAndConfirmed(context: TenantContext, matchId: string, sourceId: string) {
  const groupId = context.activeGroup.id;
  const match = await loadMatch(context, matchId);
  if (!match) return { error: notFound() } as const;
  const source = await prisma.teamGeneration.findFirst({ where: { id: sourceId, groupId, NOT: { matchId } }, select: { id: true, date: true, teamsJson: true } });
  if (!source) return { error: NextResponse.json({ error: "Those previous teams were not found for this group." }, { status: 404 }) } as const;
  const sourceTeams = parseTeams(source.teamsJson);
  if (sourceTeams.length === 0) return { error: NextResponse.json({ error: "Those previous teams can't be read." }, { status: 422 }) } as const;
  const confirmed = (await confirmedAttendeeIds(groupId, matchId)) ?? [];
  if (confirmed.length === 0) {
    return { error: NextResponse.json({ error: "Nobody is confirmed as playing for this match yet, so there's nothing to reuse the teams for.", code: "NO_CONFIRMED" }, { status: 409 }) } as const;
  }
  return { source, sourceTeams, confirmed } as const;
}

/** The roster comparison for one source (read-only). */
export async function reusePlan(context: TenantContext, matchId: string, sourceId: string): Promise<NextResponse> {
  const loaded = await loadSourceAndConfirmed(context, matchId, sourceId);
  if ("error" in loaded) return loaded.error!;
  const { source, sourceTeams, confirmed } = loaded;
  const plan = reconcileReuse(sourceTeams, confirmed);
  const colors = assignShirtColors(plan.teams, plan.teams);
  const ids = [...plan.teams.flatMap((t) => t.playerIds), ...plan.unassignedIds];
  const players = await prisma.player.findMany({ where: { groupId: context.activeGroup.id, id: { in: ids } }, select: { id: true, firstName: true, lastName: true, position: true } });
  const byId = new Map(players.map((p) => [p.id, p]));
  const person = (id: string) => {
    const p = byId.get(id)!;
    return { id, firstName: p.firstName, lastName: p.lastName, position: p.position };
  };
  return NextResponse.json(
    {
      source: { id: source.id, date: formatYMDFromDate(source.date) },
      confirmedCount: confirmed.length,
      teams: colors.map((t) => ({ teamNumber: t.teamNumber, shirtColor: t.shirtColor, players: t.playerIds.filter((id) => byId.has(id)).map(person) })),
      absent: plan.absent,
      unassigned: plan.unassignedIds.filter((id) => byId.has(id)).map(person),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Build the reused teams (organizer placements applied) into a PREVIEW: authoritative player
 * rows, carried-over colors, and the usual metrics + analysis. Nothing is saved or sent — the
 * result goes through the normal Publish flow.
 */
export async function buildReusedTeams(context: TenantContext, matchId: string, body: unknown): Promise<NextResponse> {
  const b = (body ?? {}) as { sourceId?: unknown; placements?: unknown };
  if (typeof b.sourceId !== "string" || !b.sourceId || b.sourceId.length > 64) return NextResponse.json({ error: "Choose previous teams to reuse." }, { status: 400 });
  const placements = b.placements && typeof b.placements === "object" && !Array.isArray(b.placements) ? (b.placements as Record<string, unknown>) : {};
  const loaded = await loadSourceAndConfirmed(context, matchId, b.sourceId);
  if ("error" in loaded) return loaded.error!;
  const { source, sourceTeams, confirmed } = loaded;
  const plan = reconcileReuse(sourceTeams, confirmed);
  const colored = assignShirtColors(plan.teams, plan.teams).map((t) => ({ teamNumber: t.teamNumber, shirtColor: t.shirtColor, playerIds: t.playerIds }));
  const placed = applyPlacements(colored, plan.unassignedIds, placements);
  if (!placed.ok) return NextResponse.json({ error: placed.error }, { status: 400 });

  const sport = findSport(context.activeGroup.sportKey);
  if (!sport) return NextResponse.json({ error: "This group's sport is not supported." }, { status: 400 });
  const ids = placed.teams.flatMap((t) => t.playerIds);
  const owned = await prisma.player.findMany({ where: { groupId: context.activeGroup.id, isActive: true, id: { in: ids } }, select: MATCH_PLAYER_SELECT });
  if (owned.length !== ids.length) return NextResponse.json({ error: "One or more players are invalid or unavailable." }, { status: 400 });
  const byId = new Map(owned.map((p) => [p.id, p]));
  const teams = placed.teams.map((t) => ({ teamNumber: t.teamNumber, shirtColor: t.shirtColor, players: t.playerIds.map((id) => byId.get(id)!) }));
  const config = resolveBalanceConfig(sport, await loadStoredBalanceWeights(context.activeGroup.id));
  const analysisTeams = teams.map(({ teamNumber, players }) => ({ teamNumber, players }));
  return NextResponse.json(
    {
      date: (await loadMatch(context, matchId))!.date.toISOString(),
      teams,
      reusedFromGenerationId: source.id,
      metrics: { metricsVersion: METRICS_VERSION, ...evaluateTeams(sport, config, analysisTeams) },
      analysis: analyzeTeams(sport, config, analysisTeams),
      warnings: [],
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
