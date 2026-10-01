/**
 * M6-A — the ONLY shapes player-facing views (public Group pages, share
 * links, future claimed-player views and messages) may expose.
 *
 * Published snapshots (TeamGeneration.teamsJson) contain organizer data
 * (rating, stamina, ids). Everything here is rebuilt field-by-field from
 * an explicit allow-list — never by spreading a parsed object — so new
 * snapshot fields can never leak by accident.
 *
 * Allowed: first/last name (display name), position label key, team
 * number, game date. Position is already shown on public pages (GK
 * visibility). Never: rating, stamina, Telegram ids/usernames, emails,
 * account/membership data, settings, token material.
 */

export type PlayerFacingPlayer = { firstName: string; lastName: string; position: string | null };
export type PlayerFacingTeam = { teamNumber: number; players: PlayerFacingPlayer[] };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Allow-listed teams from a published snapshot. Malformed input → []. */
export function toPlayerFacingTeams(teamsJson: string): PlayerFacingTeam[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(teamsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((t: unknown) => {
    if (!t || typeof t !== "object") return [];
    const team = t as { teamNumber?: unknown; players?: unknown };
    if (typeof team.teamNumber !== "number" || !Number.isFinite(team.teamNumber)) return [];
    const players = Array.isArray(team.players) ? team.players : [];
    return [
      {
        teamNumber: team.teamNumber,
        players: players.flatMap((p: unknown) => {
          if (!p || typeof p !== "object") return [];
          const pl = p as { firstName?: unknown; lastName?: unknown; position?: unknown };
          return [{ firstName: str(pl.firstName), lastName: str(pl.lastName), position: str(pl.position) || null }];
        }),
      },
    ];
  });
}

export function playerDisplayName(p: { firstName?: string | null; lastName?: string | null }): string {
  return `${String(p.firstName ?? "").trim()} ${String(p.lastName ?? "").trim()}`.trim() || "Unknown";
}
