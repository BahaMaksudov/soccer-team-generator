import { prisma } from "@/lib/prisma";
import { hashToken, isWellFormedToken } from "@/lib/secureToken";
import { resolveGroupForViewer } from "@/lib/groupAccess";
import { findSport, roleLabel } from "@/lib/sports";
import { playerDisplayName, toPlayerFacingTeams } from "@/lib/playerFacing";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { publishedPostGame, type ResultView } from "@/lib/postGame";

/**
 * M9-C — the player-facing Match page (canonical online destination of a
 * Match's published teams).
 *
 * Access follows Group visibility, never Telegram identity:
 *  - PUBLIC  → /g/[org]/[group]/m/[matchId], anyone;
 *  - PRIVATE → the same URL, only for a signed-in organization member or a
 *              Player of the Group claimed by the signed-in User
 *              (resolveGroupForViewer — the existing gate);
 *  - LINK    → /share/m/[matchId]#<token>: the Group's existing revocable
 *              GroupShareLink (hash-only) in the URL FRAGMENT, posted by the
 *              page to /api/share/match. The canonical URL also works for
 *              signed-in members / claimed Players.
 * Every failure (unknown org/group/match, a Match of another Group, wrong,
 * revoked or foreign token, PRIVATE via token, inactive Group) is the same
 * "not found".
 *
 * A Telegram user id is NOT browser authentication: a link click proves
 * nothing about who clicked, so nothing here reads Telegram identity.
 *
 * Teams come only from the Match's canonical published TeamGeneration
 * (matchId) — never a preview, never "latest" or by date.
 */

export type PlayerMatchView = {
  group: { name: string; teamName: string; organizationName: string; sportLabel: string };
  match: { date: string; startTime: string | null; locationName: string | null; status: "SCHEDULED" | "COMPLETED" | "CANCELED" };
  teamsPublished: boolean;
  /** Display-only: no Player ids, ratings, stamina, metrics or identities. */
  teams: Array<{ teamNumber: number; players: Array<{ name: string; role: string }> }>;
  /** M9-D — PUBLISHED post-game data only (drafts, votes, voters and AI metadata never appear). */
  /** M8.1 — PUBLISHED fixtures (every pair of teams once), or labeled pre-M8.1 per-team standings. */
  result: ResultView | null;
  mvp: { names: string[]; shared: boolean } | null;
  recap: { text: string } | null;
};

/** Allow-list DTO, built field by field. `groupId` is already authorized by the caller. */
async function buildPlayerMatchView(
  group: { id: string; name: string; sportKey: string; organizationName: string },
  matchId: string
): Promise<PlayerMatchView | null> {
  if (typeof matchId !== "string" || matchId.length === 0 || matchId.length > 64) return null;
  const match = await prisma.match.findFirst({
    where: { id: matchId, groupId: group.id },
    select: {
      date: true,
      startTime: true,
      locationName: true,
      status: true,
      generation: { select: { teamsJson: true, groupId: true } },
      result: { select: { scoresJson: true, publishedAt: true } },
      mvp: { select: { winnerPlayerIds: true, publishedAt: true } },
      recap: { select: { publishedContent: true, publishedAt: true } },
    },
  });
  if (!match) return null;
  const teamName = await prisma.groupSetting.findUnique({ where: { groupId_key: { groupId: group.id, key: "teamName" } }, select: { value: true } });
  const generation = match.generation && match.generation.groupId === group.id ? match.generation : null;
  const teams = generation
    ? toPlayerFacingTeams(generation.teamsJson).map((t) => ({
        teamNumber: t.teamNumber,
        players: t.players.map((p) => ({ name: playerDisplayName(p), role: p.position ? roleLabel(group.sportKey, p.position) : "" })),
      }))
    : [];
  return {
    group: {
      name: group.name,
      teamName: teamName?.value?.trim() || "",
      organizationName: group.organizationName,
      sportLabel: findSport(group.sportKey)?.label ?? "",
    },
    match: { date: formatYMDFromDate(match.date), startTime: match.startTime, locationName: match.locationName, status: match.status },
    teamsPublished: generation !== null,
    teams,
    ...publishedPostGame(match, generation?.teamsJson ?? null),
  };
}

/** Canonical URL access (PUBLIC, or a signed-in authorized viewer of a non-PUBLIC Group). */
export async function loadMatchForViewer(params: { organizationSlug: string; groupSlug: string; matchId: string }): Promise<PlayerMatchView | null> {
  const resolved = await resolveGroupForViewer({ organizationSlug: params.organizationSlug, groupSlug: params.groupSlug });
  if (!resolved) return null;
  return buildPlayerMatchView(
    { id: resolved.group.id, name: resolved.group.name, sportKey: resolved.group.sportKey, organizationName: resolved.organization.name },
    params.matchId
  );
}

/** Share-link access: the token decides the Group; the Match must be that Group's. LINK or PUBLIC Groups only. */
export async function resolveShareMatchView(token: unknown, matchId: unknown): Promise<PlayerMatchView | null> {
  if (!isWellFormedToken(token) || typeof matchId !== "string") return null;
  const link = await prisma.groupShareLink.findUnique({ where: { tokenHash: hashToken(token) }, select: { revokedAt: true, groupId: true } });
  if (!link || link.revokedAt) return null;
  const group = await prisma.group.findUnique({
    where: { id: link.groupId },
    select: { id: true, name: true, sportKey: true, isActive: true, visibility: true, organization: { select: { name: true } } },
  });
  if (!group || !group.isActive || (group.visibility !== "LINK" && group.visibility !== "PUBLIC")) return null;
  return buildPlayerMatchView({ id: group.id, name: group.name, sportKey: group.sportKey, organizationName: group.organization.name }, matchId);
}

export { canonicalMatchPath, shareMatchPath, SHARE_MATCH_PATH } from "@/lib/matchPaths";
