import type { MatchStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { isManager } from "@/lib/tenantRoute";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { countAttendance, type AttendanceCounts, type AttendanceRow } from "@/lib/attendance";
import { parseScores } from "@/lib/postGame";
import { canonicalAdminMatchPath } from "@/lib/matchPaths";
import { isUpcomingYmd, matchLifecycle, todayUtcYmd, type Lifecycle } from "@/lib/matchLifecycle";

/**
 * UI-4 — READ-ONLY organizer read model for a Group's Overview and Matches
 * pages. Every query is scoped by the URL-resolved context.activeGroup.id
 * (the caller passes an already-authorized TenantContext). A fixed, small
 * number of queries (no per-Match loop): the Group's Matches with their
 * published teams / result / MVP / recap, the active roster ids, the
 * attendance rows of the ONE next Match, and — for OWNER/ADMIN only — which
 * Matches have a sent Match Summary. No caching, nothing written.
 *
 * Organizer-facing only (never used by public/share pages): it carries no
 * player ratings, stamina or Telegram identity at all.
 */
export type OverviewMatch = {
  id: string;
  href: string;
  date: string;
  startTime: string | null;
  locationName: string | null;
  status: MatchStatus;
  upcoming: boolean;
  attendanceClosed: boolean;
  teamsPublished: boolean;
  /** Published result only (scores are shown once published). */
  publishedScores: Array<{ teamNumber: number; score: number }> | null;
  resultSaved: boolean;
  lifecycle: Lifecycle;
};

export type GroupOverview = {
  canManage: boolean;
  activePlayers: number;
  upcoming: OverviewMatch[];
  /** Most recent first. */
  past: OverviewMatch[];
  /** The dominant card: the next upcoming Match, else the latest past Match still in post-game. */
  focus: { kind: "next" | "latest"; match: OverviewMatch; counts: AttendanceCounts } | null;
  attention: Array<{ matchId: string; href: string; date: string; label: string }>;
};

const ATTENTION_PAST_MATCHES = 3;

export async function loadGroupOverview(context: TenantContext, now: Date = new Date()): Promise<GroupOverview> {
  const groupId = context.activeGroup.id;
  const manager = isManager(context);
  const today = todayUtcYmd(now);

  const [rows, activePlayers, summaries] = await Promise.all([
    prisma.match.findMany({
      where: { groupId },
      orderBy: [{ date: "asc" }, { startTime: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        date: true,
        startTime: true,
        locationName: true,
        status: true,
        attendanceClosedAt: true,
        generation: { select: { id: true } },
        result: { select: { scoresJson: true, publishedAt: true } },
        mvp: { select: { publishedAt: true } },
        recap: { select: { content: true, publishedAt: true } },
      },
    }),
    prisma.player.findMany({ where: { groupId, isActive: true }, select: { id: true } }),
    manager
      ? prisma.messageDelivery.findMany({ where: { groupId, eventType: "MATCH_SUMMARY_POSTED", status: "SENT" }, select: { matchId: true }, distinct: ["matchId"] })
      : Promise.resolve([] as Array<{ matchId: string | null }>),
  ]);
  const summarySent = new Set(summaries.map((s) => s.matchId));
  const activeIds = activePlayers.map((p) => p.id);

  const toMatch = (m: (typeof rows)[number], playing: number): OverviewMatch => {
    const date = formatYMDFromDate(m.date);
    const resultPublished = Boolean(m.result?.publishedAt);
    return {
      id: m.id,
      href: canonicalAdminMatchPath(context.organization.slug, context.activeGroup.slug, m.id),
      date,
      startTime: m.startTime,
      locationName: m.locationName,
      status: m.status,
      upcoming: isUpcomingYmd(m.status, date, today),
      attendanceClosed: m.attendanceClosedAt !== null,
      teamsPublished: m.generation !== null,
      publishedScores: resultPublished ? parseScores(m.result!.scoresJson).sort((a, b) => a.teamNumber - b.teamNumber) : null,
      resultSaved: m.result !== null,
      lifecycle: matchLifecycle({
        status: m.status,
        date,
        today,
        attendanceClosed: m.attendanceClosedAt !== null,
        playing,
        teamsPublished: m.generation !== null,
        result: { saved: m.result !== null, published: resultPublished },
        mvpPublished: Boolean(m.mvp?.publishedAt),
        recap: { saved: Boolean(m.recap?.content), published: Boolean(m.recap?.publishedAt) },
        // Overview approximation: "posted" once a summary was SENT (the Match page shows exact state).
        summary: manager ? (summarySent.has(m.id) ? "posted" : "not_posted") : null,
        canManage: manager,
      }),
    };
  };

  const upcomingRows = rows.filter((m) => isUpcomingYmd(m.status, formatYMDFromDate(m.date), today));
  const pastRows = rows.filter((m) => !isUpcomingYmd(m.status, formatYMDFromDate(m.date), today)).reverse();

  // Attendance counts only for the ONE Match that becomes the dominant card.
  const nextRow = upcomingRows[0] ?? null;
  const latestRow = nextRow ? null : pastRows.find((m) => m.status !== "CANCELED") ?? null;
  const focusRow = nextRow ?? latestRow;
  let focusCounts: AttendanceCounts = { PLAYING: 0, MAYBE: 0, NOT_PLAYING: 0, NO_RESPONSE: activeIds.length };
  if (focusRow) {
    const att = (await prisma.attendanceResponse.findMany({
      where: { matchId: focusRow.id, groupId },
      select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true },
    })) as AttendanceRow[];
    focusCounts = countAttendance(activeIds, att, focusRow.attendanceClosedAt);
  }

  const upcoming = upcomingRows.map((m) => toMatch(m, m.id === focusRow?.id ? focusCounts.PLAYING : 0));
  const past = pastRows.map((m) => toMatch(m, m.id === focusRow?.id ? focusCounts.PLAYING : 0));
  const focusMatch = focusRow ? [...upcoming, ...past].find((m) => m.id === focusRow.id)! : null;
  // A past Match is only the dominant card while it still has a next step.
  const focus =
    focusMatch && (nextRow || focusMatch.lifecycle.next)
      ? { kind: nextRow ? ("next" as const) : ("latest" as const), match: focusMatch, counts: focusCounts }
      : null;

  // Needs attention: the next step of the next Match and of the most recent past Matches with published teams.
  const attention: GroupOverview["attention"] = [];
  const add = (m: OverviewMatch) => {
    if (m.lifecycle.next) attention.push({ matchId: m.id, href: `${m.href}${m.lifecycle.next.anchor}`, date: m.date, label: m.lifecycle.next.label });
  };
  if (upcoming[0]) add(upcoming[0]);
  past.filter((m) => m.status !== "CANCELED" && m.teamsPublished).slice(0, ATTENTION_PAST_MATCHES).forEach(add);

  return { canManage: manager, activePlayers: activeIds.length, upcoming, past, focus, attention };
}
