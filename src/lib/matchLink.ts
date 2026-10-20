import { prisma } from "@/lib/prisma";
import { buildPlayerMatchView, type PlayerMatchView } from "@/lib/matchPage";
import { attendanceIsClosed } from "@/lib/attendanceDeadline";
import { attendanceMode, type AttendanceMode } from "@/lib/attendanceClosure";
import { MATCH_LINK_NOT_CONFIGURED, matchLinkPath, matchShareToken, verifyMatchShareToken } from "@/lib/matchShare";
import { formatStartTime } from "@/lib/messaging/content";

/**
 * M9.3 — the Match Link: one durable, per-Match capability for players
 * without Telegram or an account (/share/m/<matchId>#<token>).
 *
 * The token (src/lib/matchShare.ts) authorizes exactly ONE Match — READ ONLY:
 * the allow-listed player view (date/time/venue/map, PUBLISHED teams/result/
 * POTM/recap) and whether attendance is open. It never unlocks another Match,
 * the Group's history or any organizer data. Valid only while the Group is
 * active and LINK or PUBLIC (PRIVATE disables it). A wrong / stale (reset) /
 * foreign token or unknown Match is the same generic "not found".
 *
 * M12B — the link no longer carries a roster or accepts answers (anyone holding
 * it could answer for anyone). Players answer in the Match's Telegram poll
 * (Telegram matches) or through their own personal attendance link
 * (website-only matches, src/lib/personalAttendance.ts). Historical LINK
 * answers stay as they were.
 */

export type LinkParticipation = {
  communityName: string | null;
  /** open = answers accepted (elsewhere); otherwise why not. */
  state: "open" | "closed" | "canceled";
  /** How players answer this Match: the Telegram poll, or personal links. */
  mode: AttendanceMode;
};
export type MatchLinkView = PlayerMatchView & { link: LinkParticipation };

type LinkedMatch = {
  id: string;
  groupId: string;
  shareVersion: number;
  status: "SCHEDULED" | "COMPLETED" | "CANCELED";
  communityId: string | null;
  attendanceClosedAt: Date | null;
  /** Phase 4B — the one attendance deadline (replaces the automation cutoff here). */
  attendanceDeadlineAt: Date | null;
  communityName: string | null;
  group: { id: string; name: string; sportKey: string; organizationName: string };
};

/** Token → its Match (or null: bad/stale/foreign token, unknown Match, PRIVATE or inactive Group, not configured). */
export async function resolveLinkedMatch(token: unknown, matchId: unknown): Promise<LinkedMatch | null> {
  if (typeof matchId !== "string" || matchId.length === 0 || matchId.length > 64) return null;
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      groupId: true,
      shareVersion: true,
      status: true,
      communityId: true,
      attendanceClosedAt: true,
      attendanceDeadlineAt: true,
      community: { select: { name: true } },
      group: { select: { id: true, name: true, sportKey: true, isActive: true, visibility: true, organization: { select: { name: true } } } },
    },
  });
  if (!m || !m.group.isActive || (m.group.visibility !== "LINK" && m.group.visibility !== "PUBLIC")) return null;
  if (!verifyMatchShareToken(m.id, m.shareVersion, token)) return null;
  return {
    id: m.id,
    groupId: m.groupId,
    shareVersion: m.shareVersion,
    status: m.status,
    communityId: m.communityId,
    attendanceClosedAt: m.attendanceClosedAt,
    attendanceDeadlineAt: m.attendanceDeadlineAt,
    communityName: m.community?.name ?? null,
    group: { id: m.group.id, name: m.group.name, sportKey: m.group.sportKey, organizationName: m.group.organization.name },
  };
}

/** Whether the Match accepts answers now (canceled / completed / the shared attendance-deadline rule says closed → no). */
export function linkState(m: Pick<LinkedMatch, "status" | "attendanceClosedAt" | "attendanceDeadlineAt">, now = new Date()): LinkParticipation["state"] {
  if (m.status === "CANCELED") return "canceled";
  if (m.status === "COMPLETED" || attendanceIsClosed(m, now)) return "closed";
  return "open";
}

/** "John S." — the shortest last-name prefix that keeps names apart, then a number as a last resort. */
export function displayNames(players: Array<{ id: string; firstName: string; lastName: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const label = (p: { firstName: string; lastName: string }, n: number) => {
    const first = p.firstName.trim() || "Player";
    const last = p.lastName.trim();
    return last ? `${first} ${last.slice(0, n)}${n < last.length ? "." : ""}` : first;
  };
  for (const p of players) {
    let n = 1;
    const others = players.filter((o) => o.id !== p.id);
    while (n < p.lastName.trim().length && others.some((o) => label(o, n) === label(p, n))) n++;
    out.set(p.id, label(p, n));
  }
  const seen = new Map<string, number>();
  for (const p of players) {
    const name = out.get(p.id)!;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) out.set(p.id, `${name} (${count})`);
  }
  return out;
}

/** The read-only player view for a valid Match Link (no Player ids, no roster, no answering). */
export async function matchLinkView(token: unknown, matchId: unknown): Promise<MatchLinkView | null> {
  const m = await resolveLinkedMatch(token, matchId);
  if (!m) return null;
  const view = await buildPlayerMatchView(m.group, m.id);
  if (!view) return null;
  const mode = (await attendanceMode(m.groupId, m.id)) ?? "web";
  return { ...view, link: { communityName: m.communityName, state: linkState(m), mode } };
}

/** Organizer: the CURRENT link of a Match of the caller's Group (null when match links are not configured). */
export function currentMatchLinkPath(matchId: string, shareVersion: number): string | null {
  const token = matchShareToken(matchId, shareVersion);
  return token ? matchLinkPath(matchId, token) : null;
}

export type OrganizerMatchShare =
  | { available: true; path: string; message: { title: string; when: string; venue: string | null } }
  | { available: false; reason: "not_configured" | "private"; error: string };

const PRIVATE_MESSAGE = "This group is private, so match links don't work. Change the group's visibility to Link or Public in Group settings to share matches.";

/** OWNER/ADMIN (caller authorizes): the Match's current link + ready-to-copy message parts. */
export async function organizerMatchShare(groupId: string, matchId: string): Promise<OrganizerMatchShare | null> {
  const m = await prisma.match.findFirst({
    where: { id: matchId, groupId },
    select: { id: true, shareVersion: true, date: true, startTime: true, locationName: true, venue: { select: { name: true } }, community: { select: { name: true } }, group: { select: { name: true, visibility: true } } },
  });
  if (!m) return null;
  if (m.group.visibility === "PRIVATE") return { available: false, reason: "private", error: PRIVATE_MESSAGE };
  const path = currentMatchLinkPath(m.id, m.shareVersion);
  if (!path) {
    console.error("[match-link] MATCH_SHARE_SECRET is not configured (or shorter than 32 characters); match links are unavailable.");
    return { available: false, reason: "not_configured", error: MATCH_LINK_NOT_CONFIGURED };
  }
  const weekday = m.date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
  const day = m.date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const time = formatStartTime(m.startTime);
  return {
    available: true,
    path,
    message: { title: m.community?.name ?? m.group.name, when: `${weekday}, ${day}${time ? ` · ${time}` : ""}`, venue: m.venue?.name ?? m.locationName ?? null },
  };
}

/** OWNER/ADMIN (caller authorizes): invalidate the current link (shareVersion + 1). */
export async function resetMatchLink(groupId: string, matchId: string): Promise<boolean> {
  const { count } = await prisma.match.updateMany({ where: { id: matchId, groupId }, data: { shareVersion: { increment: 1 } } });
  return count === 1;
}
