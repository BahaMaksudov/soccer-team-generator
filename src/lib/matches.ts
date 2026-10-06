import { NextResponse } from "next/server";
import type { AttendanceStatus, MatchStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { formatYMDFromDate } from "@/lib/telegramFormat";
import { isManager, managersOnlyResponse } from "@/lib/tenantRoute";
import {
  attendanceClosedSchema,
  attendanceOverrideSchema,
  matchCreateSchema,
  matchUpdateSchema,
  zodErrorResponse,
} from "@/lib/validation";
import { scopePlayerIds, suggestedPlayerIds } from "@/lib/telegramChatScope";
import { communityMemberIds, communityTelegramChat, groupCommunity } from "@/lib/communities";
import { mapsUrl, organizationVenue } from "@/lib/venues";
import { canonicalMatchPath } from "@/lib/matchPaths";
import { postGameView } from "@/lib/postGame";
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

/**
 * UI-4B — closed attendance is READ-ONLY. While Match.attendanceClosedAt is
 * set, no path may change an individual attendance answer (organizer
 * override/clear, a player's own web answer, a Telegram answer, the Telegram
 * sync). Closing and reopening never modify existing answers or overrides.
 * Returned only AFTER the caller is authorized and the Match is found, so it
 * reveals nothing about other tenants.
 */
export const ATTENDANCE_CLOSED_MESSAGE = "Attendance is closed. Reopen attendance to make changes.";
export const attendanceClosedResponse = () => NextResponse.json({ error: ATTENDANCE_CLOSED_MESSAGE, code: "ATTENDANCE_CLOSED" }, { status: 409 });

const MATCH_SELECT = {
  id: true,
  date: true,
  startTime: true,
  locationName: true,
  status: true,
  attendanceClosedAt: true,
  communityId: true,
  venue: { select: { id: true, name: true, address: true } },
  createdAt: true,
} as const;

export type MatchSummary = {
  id: string;
  date: string;
  startTime: string | null;
  locationName: string | null;
  status: MatchStatus;
  attendanceClosed: boolean;
  /** M9.2 — the Match's Community (null: legacy Match not mapped yet). */
  communityId: string | null;
  /** M9.2 — the reusable Venue (address + keyless maps link), if any. */
  venue: { id: string; name: string; address: string | null; mapsUrl: string | null } | null;
};

function toSummary(m: {
  id: string;
  date: Date;
  startTime: string | null;
  locationName: string | null;
  status: MatchStatus;
  attendanceClosedAt: Date | null;
  communityId: string | null;
  venue?: { id: string; name: string; address: string | null } | null;
}): MatchSummary {
  return {
    id: m.id,
    date: formatYMDFromDate(m.date),
    startTime: m.startTime,
    locationName: m.locationName,
    status: m.status,
    attendanceClosed: m.attendanceClosedAt !== null,
    communityId: m.communityId,
    venue: m.venue ? { id: m.venue.id, name: m.venue.name, address: m.venue.address, mapsUrl: mapsUrl(m.venue.address) } : null,
  };
}

/**
 * M9.2 — resolve a submitted communityId inside the Group (active only) and
 * the Telegram chat that goes with it. New Matches: the only active Community
 * is the default; with several the organizer must choose; foreign/unknown/
 * inactive ids are rejected.
 */
async function resolveMatchCommunity(groupId: string, communityId: string | undefined, required: boolean) {
  if (!communityId) {
    if (!required) return { ok: true as const, community: null, chatRef: null };
    // One active Community → it is the default; several → the organizer must choose; none → no roster split.
    const active = await prisma.community.findMany({ where: { groupId, isActive: true }, select: { id: true }, take: 2 });
    if (active.length >= 2) return { ok: false as const, response: NextResponse.json({ error: "Choose the community this match is for." }, { status: 400 }) };
    if (active.length === 0) return { ok: true as const, community: null, chatRef: null };
    communityId = active[0].id;
  }
  const community = await groupCommunity(groupId, communityId, true);
  if (!community) return { ok: false as const, response: NextResponse.json({ error: "Community not found" }, { status: 404 }) };
  const chat = await communityTelegramChat(groupId, community.id);
  return { ok: true as const, community, chatRef: chat?.id ?? null };
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
  return prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: { ...MATCH_SELECT, groupId: true, telegramChatId: true, communityId: true } });
}

export async function createMatch(context: TenantContext, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = matchCreateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { date, startTime, locationName, communityId, venueId } = parsed.data;
  const resolved = await resolveMatchCommunity(context.activeGroup.id, communityId, true);
  if (!resolved.ok) return resolved.response;
  const venue = venueId ? await organizationVenue(context.organization.id, venueId, true) : null;
  if (venueId && !venue) return NextResponse.json({ error: "Venue not found" }, { status: 404 });
  const match = await prisma.match.create({
    data: {
      groupId: context.activeGroup.id,
      date: toDateOnlyUTC(date),
      startTime: startTime || null,
      // M9.2 — the Venue's name is the location shown everywhere (unless a free-text one is given).
      locationName: locationName || venue?.name || null,
      venueId: venue?.id ?? null,
      createdByUserId: context.user.id,
      // M9.2 — the Community's roster; its connected Telegram chat is the Match's default channel.
      communityId: resolved.community?.id ?? null,
      telegramChatId: resolved.chatRef,
    },
    select: MATCH_SELECT,
  });
  return NextResponse.json({ ok: true, match: toSummary(match) }, { status: 201 });
}

export async function updateMatch(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = matchUpdateSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { date, startTime, locationName, status, communityId, venueId } = parsed.data;
  let venueData: { venueId: string | null; locationName?: string } | null = null;
  if (venueId !== undefined) {
    if (venueId === null) venueData = { venueId: null };
    else {
      const venue = await organizationVenue(context.organization.id, venueId, true);
      if (!venue) return NextResponse.json({ error: "Venue not found" }, { status: 404 });
      venueData = { venueId: venue.id, ...(locationName === undefined ? { locationName: venue.name } : {}) };
    }
  }
  let communityData: { communityId: string; telegramChatId?: number | null } | null = null;
  if (communityId !== undefined) {
    const resolved = await resolveMatchCommunity(context.activeGroup.id, communityId, false);
    if (!resolved.ok) return resolved.response;
    const current = await prisma.match.findFirst({ where: { id: matchId, groupId: context.activeGroup.id }, select: { communityId: true, telegramChatId: true } });
    if (!current) return NOT_FOUND();
    // Switching Community also switches the default Telegram chat to the new Community's chat.
    communityData = current.communityId === resolved.community!.id ? { communityId: resolved.community!.id } : { communityId: resolved.community!.id, telegramChatId: resolved.chatRef };
  }
  const { count } = await prisma.match.updateMany({
    where: { id: matchId, groupId: context.activeGroup.id },
    data: {
      ...(communityData ?? {}),
      ...(venueData ?? {}),
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
    prisma.telegramChat.count({ where: { groupId, disconnectedAt: null } }),
  ]);

  let unlinkedVoters = 0;
  if (poll) {
    const answers = await prisma.telegramPollAnswer.findMany({ where: { pollId: poll.pollId, groupId }, select: { userId: true } });
    const linked = await prisma.telegramUserLink.findMany({ where: { groupId, userId: { in: answers.map((a) => a.userId) } }, select: { userId: true } });
    const linkedSet = new Set(linked.map((l) => l.userId.toString()));
    unlinkedVoters = answers.filter((a) => !linkedSet.has(a.userId.toString())).length;
  }

  // M9.2 — the Match's Community is its roster. Eligible = ACTIVE members;
  // Players outside it appear only when they already have state on this
  // Match (an answer, an override, a published team place) or are a linked-
  // voter suggestion, flagged inCommunity:false — never counted, never
  // selected by default. Legacy Matches without a Community keep the
  // whole-Group roster until an organizer assigns one.
  const community = match.communityId ? await prisma.community.findFirst({ where: { id: match.communityId, groupId }, select: { id: true, name: true, isActive: true } }) : null;
  const members = community ? new Set(await communityMemberIds(groupId, community.id)) : null;
  const communities = manager
    ? await prisma.community.findMany({ where: { groupId, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })
    : [];

  // M9-B — the selected Telegram chat's DEFAULT player scope. Player ids only
  // (everyone who can open the workspace sees the same default roster); chat
  // titles, the chat list and linked-voter suggestions are OWNER/ADMIN only.
  const selectedChat = match.telegramChatId
    ? await prisma.telegramChat.findFirst({ where: { id: match.telegramChatId, groupId }, select: { id: true, chatId: true, title: true, disconnectedAt: true } })
    : null;
  const [scopeIds, suggestions, chats] = await Promise.all([
    selectedChat ? scopePlayerIds(groupId, selectedChat.id) : Promise.resolve([] as string[]),
    selectedChat && manager ? suggestedPlayerIds(groupId, selectedChat) : Promise.resolve([] as string[]),
    manager
      ? prisma.telegramChat.findMany({ where: { groupId, disconnectedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, title: true } })
      : Promise.resolve([] as Array<{ id: number; title: string | null }>),
  ]);

  const rows = attendance as AttendanceRow[];
  const byPlayer = new Map(rows.map((r) => [r.playerId, r]));
  const onTeams = new Set(generation ? publishedTeamsOf(generation.teamsJson).flatMap((t) => t.players.map((p) => p.id)) : []);
  const inCommunity = (id: string) => (members ? members.has(id) : true);
  const listed = members
    ? players.filter((p) => members.has(p.id) || byPlayer.has(p.id) || onTeams.has(p.id) || suggestions.includes(p.id))
    : players;
  // The eligible roster everything roster-dependent is counted against.
  const eligible = players.filter((p) => p.isActive && inCommunity(p.id));
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
    community: community ? { id: community.id, name: community.name, isActive: community.isActive } : null,
    // M9.2 — what Match Automation did (organizers only; null for a Match not created by a schedule).
    automation: manager ? await automationView(groupId, matchId) : null,
    communities: communities,
    roster: listed.map(({ rating, stamina, ...safe }) => {
      const p = { ...safe, inCommunity: inCommunity(safe.id) };
      const r = byPlayer.get(p.id);
      const eff = effectiveAttendance(r, match.attendanceClosedAt);
      return {
        // UI-7 — balancing data (skill / stamina) for OWNER/ADMIN only; MEMBER's
        // serialized roster has no rating/stamina keys at all.
        ...(manager ? { rating, stamina } : {}),
        ...p,
        attendance: {
          ...eff,
          participantStatus: r?.participantStatus ?? null,
          participantSource: r?.participantSource ?? null,
        },
      };
    }),
    // M9.2 — Playing / Maybe / Not Playing / Not Responded (NO_RESPONSE) over the
    // eligible roster only: they always add up to rosterSize.
    counts: countAttendance(
      eligible.map((p) => p.id),
      rows,
      match.attendanceClosedAt
    ),
    rosterSize: eligible.length,
    defaultSelection: defaultSelection(eligible, rows, match.attendanceClosedAt),
    // The PUBLISHED teams for this Match (organizer view: ids/names/roles only),
    // so the workspace can tell them apart from a working preview after a reload.
    generation: generation
      ? { id: generation.id, date: formatYMDFromDate(generation.date), updatedAt: generation.updatedAt.toISOString(), teams: publishedTeamsOf(generation.teamsJson) }
      : null,
    // M9.2 — with a Community the default roster is its members (the chat scope IS the Community).
    scope: community ? { chatSelected: true, playerIds: [...members!] } : { chatSelected: selectedChat !== null, playerIds: scopeIds },
    // M9-D — result / MVP / recap (organizer view; aggregate MVP counts only).
    postGame: await postGameView(context, matchId),
    // M9-C — the player-facing Match page (no token: LINK Groups share it via the Group's share link).
    playerPage: {
      path: canonicalMatchPath(context.organization.slug, context.activeGroup.slug, matchId),
      visibility: (await prisma.group.findFirst({ where: { id: groupId }, select: { visibility: true } }))?.visibility ?? "PRIVATE",
    },
    telegram: {
      connected: chatCount > 0,
      chats: chats.map((c) => ({ ref: c.id, title: c.title || "Telegram group" })),
      selectedChat:
        manager && selectedChat
          ? { ref: selectedChat.id, title: selectedChat.title || "Telegram group", connected: selectedChat.disconnectedAt === null }
          : null,
      suggestedPlayerIds: suggestions,
      poll: poll ? { pollId: manager ? poll.pollId : null, closed: poll.isClosed, postedAt: poll.createdAt.toISOString() } : null,
      unlinkedVoters,
      pollDelivery: pollDeliveries[0] ? { status: pollDeliveries[0].status, sentAt: pollDeliveries[0].sentAt?.toISOString() ?? null } : null,
    },
  });
}

/** M9.2 — organizer-facing automation status of a scheduled Match. */
async function automationView(groupId: string, matchId: string) {
  const a = await prisma.matchAutomation.findFirst({
    where: { matchId, groupId },
    select: { pollDueAt: true, cutoffDueAt: true, pollPostedAt: true, cutoffCompletedAt: true, notifiedAt: true, lastError: true, lastErrorAt: true, match: { select: { schedule: { select: { isActive: true } } } } },
  });
  if (!a) return null;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    scheduleActive: a.match.schedule?.isActive ?? false,
    pollDueAt: iso(a.pollDueAt),
    cutoffDueAt: iso(a.cutoffDueAt),
    pollPostedAt: iso(a.pollPostedAt),
    cutoffCompletedAt: iso(a.cutoffCompletedAt),
    notifiedAt: iso(a.notifiedAt),
    lastError: a.lastError,
    lastErrorAt: iso(a.lastErrorAt),
  };
}

/** Organizer override (set or clear). Authoritative until cleared; participant responses are kept. */
export async function setAttendanceOverride(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = attendanceOverrideSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const match = await findGroupMatch(context, matchId);
  if (!match) return NOT_FOUND();
  if (match.attendanceClosedAt) return attendanceClosedResponse();
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

/**
 * Open/close attendance (a timestamp only — no answer or override is changed).
 * UI-4B: while closed, attendance is read-only on every path; reopening
 * restores normal changes. No automatic cutoff.
 */
export async function setAttendanceClosed(context: TenantContext, matchId: string, req: Request): Promise<NextResponse> {
  // UI-4A — organizer mutation: OWNER/ADMIN only (MEMBER gets the generic 404).
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
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
 * accept no responses. UI-4B — nor does a Match whose attendance is closed
 * ("closed" is reported only to a claimed participant of that Match's Group).
 */
export async function setOwnAttendance(userId: string, matchId: string, status: AttendanceStatus): Promise<"ok" | "not_found" | "closed"> {
  const match = await prisma.match.findFirst({ where: { id: matchId, status: { not: "CANCELED" } }, select: { id: true, groupId: true, attendanceClosedAt: true } });
  if (!match) return "not_found";
  const player = await prisma.player.findFirst({ where: { groupId: match.groupId, userId }, select: { id: true } });
  if (!player) return "not_found";
  if (match.attendanceClosedAt) return "closed";
  await prisma.$transaction((tx) =>
    recordParticipantResponse(tx, { matchId: match.id, groupId: match.groupId, playerId: player.id, status, source: "WEB", at: new Date() })
  );
  return "ok";
}
