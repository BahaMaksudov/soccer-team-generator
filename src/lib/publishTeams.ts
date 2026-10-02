import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";
import { publishTeamsSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";
import { ENGINE_VERSION, resolveBalanceConfig } from "@/lib/balanceEngine";
import { buildStoredMetrics } from "@/lib/balanceAnalysis";
import { findSport, type SportDefinition } from "@/lib/sports";
import { loadStoredBalanceWeights } from "@/lib/groupSettings";

/**
 * Phase 2D.6D.3 — shared Publish core, originally extracted from the
 * legacy /api/admin/publish route.
 *
 * Phase 2D.6D.5E.5 — the legacy flat route is deleted and this core is
 * now permanently DB-only: it saves the TeamGeneration for
 * (activeGroup, date) and nothing else. The old embedded Telegram
 * poll-close/teams-post branch, its private Telegram helper, and the
 * PublishOptions/allowTelegramPollActions switch are removed.
 * Generated teams reach Telegram ONLY through the separate canonical
 * Close Poll & Post Teams operation (src/lib/telegramCloseAndPost.ts),
 * which carries the durable teamsPostStatus idempotency state.
 *
 * Tenant identity is always the caller-resolved context.activeGroup —
 * never request-body groupId/organizationId.
 *
 * Phase 2D.6E.6C — the submitted team contents are also validated: every
 * player id must belong to the active Group before anything is saved.
 */
const INVALID_PLAYERS_MESSAGE = "One or more players are invalid or unavailable.";

/**
 * Phase 2D.6E.6C — returns the player ids in a submitted Publish payload,
 * or null when the payload can't be validated: a player without a
 * non-empty string `id`, the same id appearing more than once (a player
 * can't be on two teams), or no players at all. Canonical Generate
 * always returns stable Player ids, so a legitimate Generate → Preview →
 * Publish payload always passes this shape check.
 */
export function collectSubmittedPlayerIds(teams: Array<{ players: Array<Record<string, unknown>> }>): string[] | null {
  const ids: string[] = [];
  for (const team of teams) {
    for (const player of team.players) {
      const id = player.id;
      if (typeof id !== "string" || id.trim() === "") return null;
      ids.push(id);
    }
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length) return null;
  return ids;
}

/**
 * Phase 2D.6E.6D — the exact Player fields a published snapshot stores:
 * the same fields canonical Generate returns and that published teams
 * have always carried. Explicit allowlist — never groupId, timestamps,
 * Telegram fields, or anything else on the Player row.
 */
const SNAPSHOT_PLAYER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  position: true,
  rating: true,
  stamina: true,
} as const;

type SnapshotPlayer = {
  id: string;
  firstName: string;
  lastName: string;
  position: string;
  rating: string;
  stamina: number;
};

/**
 * Phase 2D.6E.6D — rebuilds the submitted teams into the snapshot that is
 * persisted: each team keeps only its client-assigned `teamNumber` and
 * its players IN THE SUBMITTED ORDER, and every player is replaced by an
 * explicit copy of the authoritative Group-owned row. Nothing else from
 * the request (extra team keys, player fields, injected keys) survives.
 * Callers must have already verified every id is in `ownedPlayers`.
 */
export function buildPublishSnapshot(
  teams: Array<{ teamNumber: number; players: Array<Record<string, unknown>> }>,
  ownedPlayers: SnapshotPlayer[]
): Array<{ teamNumber: number; players: SnapshotPlayer[] }> {
  const byId = new Map(ownedPlayers.map((p) => [p.id, p]));
  return teams.map((team) => ({
    teamNumber: team.teamNumber,
    players: team.players.map((submitted) => {
      const p = byId.get(submitted.id as string);
      if (!p) throw new Error("buildPublishSnapshot: unverified player id");
      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        position: p.position,
        rating: p.rating,
        stamina: p.stamina,
      };
    }),
  }));
}

/**
 * M7 — generation metadata stored next to the snapshot: the Group's sport,
 * the engine version, and aggregate BalanceMetrics computed from the
 * ALLOW-LISTED snapshot (never raw request data, never raw teamsJson).
 * Metrics contain no player ids, names or identity fields.
 *
 * M8-A — metricsJson is now `metrics-v2`: the same metrics plus
 * `metricsVersion` and the deterministic balance analysis
 * (`balance-analysis-v1`: quality, spreads, roster notes, role coverage,
 * improvable). Swap suggestions, player ids and summary text are never stored.
 */
export function buildGenerationMetadata(
  sport: SportDefinition,
  storedWeights: unknown,
  snapshotTeams: Array<{ teamNumber: number; players: SnapshotPlayer[] }>
): { sportKey: string; engineVersion: string; metricsJson: string } {
  const stored = buildStoredMetrics(sport, resolveBalanceConfig(sport, storedWeights), snapshotTeams);
  return { sportKey: sport.key, engineVersion: ENGINE_VERSION, metricsJson: JSON.stringify(stored) };
}

export async function publishTeamsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = publishTeamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { date: dateStr, teams, pollId, matchId } = parsed.data;

  // Reject BEFORE any TeamGeneration write: Publish never performs
  // Telegram poll actions, and silently ignoring a caller that asks for
  // them (e.g. a stale pre-5E client) would hide that its intent was not
  // carried out. pollId is empty-string by default (publishTeamsSchema),
  // so a request that never mentions Telegram is unaffected.
  if (pollId) {
    return NextResponse.json(
      { error: "Telegram poll actions are not supported on this endpoint." },
      { status: 400 }
    );
  }

  // Phase 2D.6E.6C — every submitted player must be one of THIS Group's
  // Players, checked BEFORE the upsert. Otherwise a caller could store
  // (and later post) another Group's players in its own generation. The
  // client error is generic and never says which id failed or why.
  const playerIds = collectSubmittedPlayerIds(teams);
  if (!playerIds) {
    return NextResponse.json({ error: INVALID_PLAYERS_MESSAGE }, { status: 400 });
  }
  const owned = await prisma.player.findMany({
    where: { groupId: activeGroupId, id: { in: playerIds } },
    select: SNAPSHOT_PLAYER_SELECT,
  });
  if (owned.length !== playerIds.length) {
    return NextResponse.json({ error: INVALID_PLAYERS_MESSAGE }, { status: 400 });
  }

  // Phase 2D.6E.6D — the client decides WHO is on which team and in what
  // order; the server decides WHAT is stored about each player. The
  // persisted snapshot is rebuilt from the Group-owned Player rows, so
  // forged names/positions/ratings/stamina and injected keys are never
  // stored. It is a snapshot taken now: later Player edits don't change it.
  const snapshotTeams = buildPublishSnapshot(teams, owned);

  const sport = findSport(context.activeGroup.sportKey);
  if (!sport) {
    return NextResponse.json({ error: "This group's sport is not supported." }, { status: 400 });
  }
  const metadata = buildGenerationMetadata(sport, await loadStoredBalanceWeights(activeGroupId), snapshotTeams);

  const normalizedDate = toDateOnlyUTC(dateStr);

  // M9-A — publishing for a Match: the Match must be this Group's and on the
  // same date. TeamGeneration is still unique per (Group, date), so if that
  // date's teams already belong to ANOTHER Match (two Matches on one day) the
  // publish is refused rather than re-associated (known transitional
  // limitation). Legacy by-date publishes (no matchId) keep any link as is.
  if (matchId) {
    const match = await prisma.match.findFirst({ where: { id: matchId, groupId: activeGroupId }, select: { id: true, date: true } });
    if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });
    if (match.date.getTime() !== normalizedDate.getTime()) {
      return NextResponse.json({ error: "The teams date must be the match date." }, { status: 400 });
    }
    const [sameDate, linked] = await Promise.all([
      prisma.teamGeneration.findUnique({ where: { groupId_date: { groupId: activeGroupId, date: normalizedDate } }, select: { id: true, matchId: true } }),
      prisma.teamGeneration.findFirst({ where: { matchId, groupId: activeGroupId }, select: { id: true } }),
    ]);
    if (sameDate?.matchId && sameDate.matchId !== matchId) {
      return NextResponse.json(
        { error: "Teams for another match on this date are already published. Only one match per day can have saved teams for now.", code: "SAME_DAY_MATCH_TEAMS" },
        { status: 409 }
      );
    }
    if (linked && linked.id !== sameDate?.id) {
      return NextResponse.json({ error: "This match already has teams saved for a different date. Delete them first.", code: "MATCH_TEAMS_OTHER_DATE" }, { status: 409 });
    }
  }
  const matchLink = matchId ? { matchId } : {};

  // ---------------------------------------------------------------
  // Phase 2D.2b: TeamGeneration is uniquely constrained on
  // (groupId, date). The compound selector's `groupId` is always
  // context.activeGroup.id, never client input, in both the selector
  // and the create payload, so this can only ever address (and only
  // ever create) a row owned by the caller's own Group. A different
  // Group publishing on the same date is a fully independent row.
  // ---------------------------------------------------------------
  let saved;
  try {
    saved = await prisma.teamGeneration.upsert({
      where: { groupId_date: { groupId: activeGroupId, date: normalizedDate } },
      update: { teamsJson: JSON.stringify(snapshotTeams), ...metadata, ...matchLink },
      create: { date: normalizedDate, teamsJson: JSON.stringify(snapshotTeams), groupId: activeGroupId, ...metadata, ...matchLink },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to save published teams.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Legacy public surface (`/` now redirects to the default public
  // Group's canonical page), kept fresh regardless.
  revalidatePath("/");

  // Canonical public surfaces for this specific Group. Paths derive from
  // context.organization.slug/context.activeGroup.slug (never request
  // input), so this only ever revalidates the caller's own Group's pages.
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}`);
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}/print/${saved.id}`);

  return NextResponse.json({ ok: true, id: saved.id });
}

export async function deletePublishedTeamsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const dateStr = url.searchParams.get("date"); // expected YYYY-MM-DD

  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return NextResponse.json(
      { error: "date query param is required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  /**
   * Interpret the date as a CALENDAR DAY, not a moment in time.
   * We build a UTC range that safely covers that whole day.
   */
  const [y, m, d] = dateStr.split("-").map(Number);

  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));

  // deleteMany is a single filter-based statement — adding groupId
  // here is fully atomic and correct: a tenant can only ever delete
  // rows that are both in this date range AND already owned by their
  // own active Group.
  const result = await prisma.teamGeneration.deleteMany({
    where: { date: { gte: start, lt: end }, groupId: context.activeGroup.id },
  });

  revalidatePath("/");
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}`);

  return NextResponse.json({ ok: true, deleted: result.count, date: dateStr });
}
