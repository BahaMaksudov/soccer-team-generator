/**
 * M9-D — participants of a Match = the Players of its PUBLISHED teams, read
 * from the snapshot (stable Player ids + historical names), independent of
 * today's roster, attendance or Telegram chat scope.
 */
export type Participant = { playerId: string; name: string; teamNumber: number };

/** Participants of the PUBLISHED teams (snapshot ids/names — historical, independent of today's roster). */
export function participantsOf(teamsJson: string | null | undefined): Participant[] {
  if (!teamsJson) return [];
  try {
    const teams = JSON.parse(teamsJson);
    if (!Array.isArray(teams)) return [];
    return teams.flatMap((t: { teamNumber?: unknown; players?: unknown }) =>
      Number.isInteger(t?.teamNumber) && Array.isArray(t.players)
        ? t.players.flatMap((p: { id?: unknown; firstName?: unknown; lastName?: unknown }) =>
            typeof p?.id === "string" ? [{ playerId: p.id, name: `${String(p.firstName ?? "").trim()} ${String(p.lastName ?? "").trim()}`.trim() || "Player", teamNumber: t.teamNumber as number }] : []
          )
        : []
    );
  } catch {
    return [];
  }
}
