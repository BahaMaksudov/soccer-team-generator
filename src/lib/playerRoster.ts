/**
 * UI-5 — pure roster view rules for the organizer Players page (search,
 * filters, ordering, summary). Presentation only: the list comes from the
 * existing tenant-bound GET /players; nothing here grants or changes data.
 */
export type RosterStatusFilter = "all" | "active" | "inactive";
export type RosterPlayer = { id: string; firstName: string; lastName: string; position: string; isActive: boolean };

export const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

export function filterRoster<T extends RosterPlayer>(players: T[], f: { q: string; status: RosterStatusFilter; role: string | "all" }): T[] {
  const q = f.q.trim().toLowerCase();
  return players
    .filter((p) => !q || fullName(p).toLowerCase().includes(q))
    .filter((p) => f.status === "all" || (f.status === "active" ? p.isActive : !p.isActive))
    .filter((p) => f.role === "all" || p.position === f.role)
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || fullName(a).localeCompare(fullName(b)));
}

export function rosterSummary(players: RosterPlayer[]) {
  const active = players.filter((p) => p.isActive).length;
  return { total: players.length, active, inactive: players.length - active };
}

export function initials(p: { firstName: string; lastName: string }) {
  return ((p.firstName[0] ?? "") + (p.lastName[0] ?? "")).toUpperCase() || "?";
}
