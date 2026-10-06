import { SPORTS } from "@/lib/sports";

/**
 * UI-1 — the homepage's sport cards, derived from the PRODUCTION sport
 * registry (user-facing labels, emoji and role names only — never internal
 * keys such as flag_football). Catch-all roles (Any, Athletes, …) are left out
 * of the role summary.
 */
export type MarketingSport = { label: string; emoji: string; roles: string };

const CATCH_ALL = new Set(["ANY", "ATHLETE", "ALL_AROUND", "PLAYER"]);

export function marketingSports(): MarketingSport[] {
  return SPORTS.map((s) => {
    const named = s.roles.filter((r) => !CATCH_ALL.has(r.key)).map((r) => r.pluralLabel);
    return {
      label: s.label,
      emoji: s.messaging.emoji,
      roles: named.length >= 2 ? `${named.slice(0, 3).join(", ")}` : "Any team game you run",
    };
  });
}
