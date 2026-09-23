/**
 * Shared Admin-page types, extracted during the Phase 1.5 structural
 * refactor. Moved here only because more than one component needs
 * them — nothing else changed about their shape.
 */

export type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
  rating: "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  stamina: number;
  isActive: boolean;
};

export type TelegramUser = {
  userId: string; // BigInt as string
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

export type TgPollItem = {
  pollId: string;
  chatId: string;
  chatTitle: string;
  question: string;
  pollDate: string | null; // machine-readable, YYYY-MM-DD — for previewDate/date inputs
  pollDateStr: string | null; // human-readable, M/D/YY — for display only
  isClosed: boolean;
};

/** Shape of a single generated team, as returned by /api/admin/generate
 * and as stored/rendered by the preview + publish flow. */
export type GeneratedTeam = {
  teamNumber: number;
  players: Array<{
    id: string;
    firstName: string;
    lastName: string;
    position: Player["position"];
  }>;
};
