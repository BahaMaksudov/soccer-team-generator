import { NextResponse } from "next/server";
import type { AttendanceStatus, MatchStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { isManager } from "@/lib/tenantRoute";
import {
  attendanceClosedSchema,
  attendanceOverrideSchema,
  matchCreateSchema,
  matchUpdateSchema,
  zodErrorResponse,
} from "@/lib/validation";
import { countAttendance, defaultSelection, effectiveAttendance, recordParticipantResponse, type AttendanceRow } from "@/lib/attendance";

/**
 * M9-A — Match domain services (canonical, URL-bound callers pass an
 * already-authorized TenantContext; everything is scoped by
 * context.activeGroup.id — a foreign/unknown Match id is a 404).
 *
 * Nothing here sends anything: creating/editing a Match, attendance
 * changes and closing attendance are SAVE operations only. External posts
 * live in src/lib/telegramAttendance.ts (OWNER/ADMIN).
 *
 * A Group may have several Matches on the same date (identity = id).
 */

const NOT_FOUND = () => NextResponse.json({ error: "Match not found" }, { status: 404 });

const MATCH_SELECT = {
  id: true,
  date: true,
  startTime: true,
  locationName: true,
  status: true,
  attendanceClosedAt: true,
  createdAt: true,
} as const;

export type MatchSummary = {
  id: string;
  date: string;
  startTime: string | null;
  locationName: string | null;
  status: MatchStatus;
  attendanceClosed: boolean;
};

function toSummary(m: { id: string; date: Date; startTime: string | null; locationName: string | null; status: MatchStatus; attendanceClosedAt: Date | null }): MatchSummary {
  return {
    id: m.id,
    date: formatYMDFromDate(m.date),
    startTime: m.startTime,
    locationName: m.locationName,
    status: m.status,
    attendanceClosed: m.attendanceClosedAt !== null,
  };
}

/** Published snapshot → organizer-facing teams (only id, names and role key). */
export function publishedTeamsOf(teamsJson: string): Array<{ teamNumber: number; players: Array<{ id: string; firstName: string; lastName: string; position: string }> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(teamsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return parsed.flatMap((t: unknown) => {
    const team = t as { teamNumber?: unknown; players?: unknown };
    if (!team || typeof team.teamNumber !== "number") return [];
    const players = (Array.isArray(team.players) ? team.players : []).flatMap((p: unknown) => {
      const pl = p as Record<string, unknown>;
      return pl && typeof pl.id === "string" ? [{ id: pl.id, firstName: str(pl.firstName), lastName: str(pl.lastName), position: str(pl.position) }] : [];
    });
    return [{ teamNumber: team.teamNumber, players }];
  });
}

export async function findGroupMatch(context: TenantContext, matchId: string) {
  return prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: { ...MATCH_SELECT, groupId: true } });
}

export async function createMatch(context: TenantContext, req: Request): Promise<NextResponse> {
  const parsed = matchCreateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { date, startTime, locationName } = parsed.data;
  const match = await prisma.match.create({
    data: {
      groupId: context.activeGroup.id,
      date: toDateOnlyUTC(date),
      startTime: startTime || null,
      locationName: locationName || null,
      createdByUserId: context.user.id,
    },
    select: MATCH_SELECT,
  });
  return NextResponse.json({ ok: true, match: toSummary(match) }, { status: 201 });
}

export async function updateMatch(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const parsed = matchUpdateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { date, startTime, locationName, status } = parsed.data;
  const { count } = await prisma.match.updateMany({
    where: { id: matchId, groupId: context.activeGroup.id },
    data: {
      ...(date !== undefined ? { date: toDateOnlyUTC(date) } : {}),
      ...(startTime !== undefined ? { startTime: startTime || null } : {}),
      ...(locationName !== undefined ? { locationName: locationName || null } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  if (count !== 1) return NOT_FOUND();
  const match = await prisma.match.findFirstOrThrow({ where: { id: matchId, groupId: context.activeGroup.id }, select: MATCH_SELECT });
  return NextResponse.json({ ok: true, match: toSummary(match) });
}

export async function listMatches(context: TenantContext): Promise<NextResponse> {
  const rows = await prisma.match.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: [{ date: "asc" }, { startTime: "asc" }, { createdAt: "asc" }],
    select: MATCH_SELECT,
  });
  const today = toDateOnlyUTC(new Date().toISOString().slice(0, 10)).getTime();
  const upcoming = rows.filter((m) => m.status === "SCHEDULED" && m.date.getTime() >= today).map(toSummary);
  const past = rows.filter((m) => !(m.status === "SCHEDULED" && m.date.getTime() >= today)).reverse().map(toSummary);
  return NextResponse.json({ upcoming, past });
}

const ATTENDANCE_SELECT = {
  playerId: true,
  participantStatus: true,
  participantSource: true,
  participantRespondedAt: true,
  overrideStatus: true,
  overrideAt: true,
} as const;

/**
 * The organizer's Match workspace view. Ratings are already part of the
 * organizer Players view; Telegram identity is NOT included (only a count
 * of unlinked voters, and poll/delivery state for OWNER/ADMIN).
 */
export async function getMatchView(context: TenantContext, matchId: string): Promise<NextResponse> {
  const groupId = context.activeGroup.id;
  const match = await findGroupMatch(context, matchId);
  if (!match) return NOT_FOUND();
  const manager = isManager(context);

  const [players, attendance, generation, poll, chatCount] = await Promise.all([
    prisma.player.findMany({
      where: { groupId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, position: true, rating: true, stamina: true, isActive: true },
    }),
    prisma.attendanceResponse.findMany({ where: { matchId, groupId }, select: ATTENDANCE_SELECT }),
    prisma.teamGeneration.findFirst({ where: { matchId, groupId }, select: { id: true, date: true, updatedAt: true, teamsJson: true } }),
    prisma.telegramPoll.findFirst({
      where: { matchId, groupId, kind: "ATTENDANCE" },
      orderBy: { createdAt: "desc" },
      select: { pollId: true, isClosed: true, createdAt: true },
    }),
    prisma.telegramChat.count({ where: { groupId } }),
  ]);

  let unlinkedVoters = 0;
  if (poll) {
    const answers = await prisma.telegramPollAnswer.findMany({ where: { pollId: poll.pollId, groupId }, select: { userId: true } });
    const linked = await prisma.telegramUserLink.findMany({ where: { groupId, userId: { in: answers.map((a) => a.userId) } }, select: { userId: true } });
    const linkedSet = new Set(linked.map((l) => l.userId.toString()));
    unlinkedVoters = answers.filter((a) => !linkedSet.has(a.userId.toString())).length;
  }

  const rows = attendance as AttendanceRow[];
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const pollDeliveries = manager
    ? await prisma.messageDelivery.findMany({
        where: { matchId, groupId, eventType: "ATTENDANCE_POLL_POSTED" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, sentAt: true },
      })
    : [];

  return NextResponse.json({
    match: toSummary(match),
    canManage: manager,
    roster: players.map((p) => {
      const r = byPlayer.get(p.id);
      const eff = effectiveAttendance(r, match.attendanceClosedAt);
      return {
        ...p,
        attendance: {
          ...eff,
          participantStatus: r?.participantStatus ?? null,
          participantSource: r?.participantSource ?? null,
        },
      };
    }),
    counts: countAttendance(
      players.filter((p) => p.isActive).map((p) => p.id),
      rows,
      match.attendanceClosedAt
    ),
    defaultSelection: defaultSelection(players, rows, match.attendanceClosedAt),
    // The PUBLISHED teams for this Match (organizer view: ids/names/roles only),
    // so the workspace can tell them apart from a working preview after a reload.
    generation: generation
      ? { id: generation.id, date: formatYMDFromDate(generation.date), updatedAt: generation.updatedAt.toISOString(), teams: publishedTeamsOf(generation.teamsJson) }
      : null,
    telegram: {
      connected: chatCount > 0,
      poll: poll ? { pollId: manager ? poll.pollId : null, closed: poll.isClosed, postedAt: poll.createdAt.toISOString() } : null,
      unlinkedVoters,
      pollDelivery: pollDeliveries[0] ? { status: pollDeliveries[0].status, sentAt: pollDeliveries[0].sentAt?.toISOString() ?? null } : null,
    },
  });
}

/** Organizer override (set or clear). Authoritative until cleared; participant responses are kept. */
export async function setAttendanceOverride(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const parsed = attendanceOverrideSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const match = await findGroupMatch(context, matchId);
  if (!match) return NOT_FOUND();
  const player = await prisma.player.findFirst({ where: { id: parsed.data.playerId, groupId }, select: { id: true } });
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  const status = parsed.data.status as AttendanceStatus | null;
  const data = status
    ? { overrideStatus: status, overrideByUserId: context.user.id, overrideAt: new Date() }
    : { overrideStatus: null, overrideByUserId: null, overrideAt: null };
  await prisma.attendanceResponse.upsert({
    where: { matchId_playerId: { matchId, playerId: player.id } },
    update: data,
    create: { matchId, groupId, playerId: player.id, ...data },
  });
  return NextResponse.json({ ok: true });
}

/** Open/close attendance (a timestamp; late responses are still recorded and flagged). No automatic cutoff. */
export async function setAttendanceClosed(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  const parsed = attendanceClosedSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { count } = await prisma.match.updateMany({
    where: { id: matchId, groupId: context.activeGroup.id },
    data: { attendanceClosedAt: parsed.data.closed ? new Date() : null },
  });
  if (count !== 1) return NOT_FOUND();
  return NextResponse.json({ ok: true, attendanceClosed: parsed.data.closed });
}

/**
 * A signed-in User sets their OWN attendance for a Match of a Group where
 * they have claimed a Player. Never for another Player. Canceled Matches
 * accept no responses.
 */
export async function setOwnAttendance(userId: string, matchId: string, status: AttendanceStatus): Promise<"ok" | "not_found"> {
  const match = await prisma.match.findFirst({ where: { id: matchId, status: { not: "CANCELED" } }, select: { id: true, groupId: true } });
  if (!match) return "not_found";
  const player = await prisma.player.findFirst({ where: { groupId: match.groupId, userId }, select: { id: true } });
  if (!player) return "not_found";
  await prisma.$transaction((tx) =>
    recordParticipantResponse(tx, { matchId: match.id, groupId: match.groupId, playerId: player.id, status, source: "WEB", at: new Date() })
  );
  return "ok";
}
