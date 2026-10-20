import type { AttendanceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { communityRosterIds } from "@/lib/communities";
import { attendanceIsClosed, effectiveClosedAt, kickoffAt } from "@/lib/attendanceDeadline";
import { effectiveAttendance, recordParticipantResponse, type AttendanceRow } from "@/lib/attendance";
import { attendanceMode, lockMatchForAnswer } from "@/lib/attendanceClosure";
import { formatDeadline } from "@/lib/deadlineFormat";

/**
 * M12B — personal attendance links for WEBSITE-ONLY matches (no Telegram poll).
 *
 * A link authorizes exactly ONE Player to answer for exactly ONE Match:
 *   - token: 32 random bytes (base64url) in the URL FRAGMENT (/attend#<token>) —
 *     never sent to the server in a URL, so never in access logs or Referer;
 *     the page posts it in a JSON body. Only its SHA-256 hash is stored.
 *   - the Player comes from the link row, never from the browser.
 *   - valid while: not revoked, the Group is active, the Match is scheduled and
 *     its attendance is open (the shared deadline rule — the link "expires" at
 *     the deadline / close), the Player is still active and on the Match's
 *     roster, and the Match is a website-only match (a Telegram poll match is
 *     answered in the poll — one workflow per match).
 *   - per-link answer rate limit kept in the row (database-backed).
 * Organizers (OWNER/ADMIN; callers authorize) create, regenerate (= revoke + new)
 * and revoke links and distribute them themselves — nothing is sent. Organizer
 * overrides keep precedence; answers are recorded as source PERSONAL_LINK.
 */
export const PERSONAL_ATTENDANCE_PATH = "/attend";
export const LINK_ANSWER_LIMIT = { max: 20, windowMs: 10 * 60_000 } as const;
export const personalLinkPath = (token: string) => `${PERSONAL_ATTENDANCE_PATH}#${token}`;

type MatchRow = { id: string; groupId: string; communityId: string | null; status: "SCHEDULED" | "COMPLETED" | "CANCELED"; attendanceClosedAt: Date | null; attendanceDeadlineAt: Date | null };

/** The Match's eligible roster (active Community members, or the Group's active Players). */
async function rosterIds(m: Pick<MatchRow, "groupId" | "communityId">): Promise<Set<string>> {
  if (m.communityId) return new Set(await communityRosterIds(m.groupId, m.communityId));
  return new Set((await prisma.player.findMany({ where: { groupId: m.groupId, isActive: true }, select: { id: true } })).map((p) => p.id));
}

const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

// ------------------------------------------------------------------ organizer

export type OrganizerLinkRow = {
  playerId: string;
  name: string;
  link: { createdAt: string; lastUsedAt: string | null } | null;
  response: { status: AttendanceStatus | null; source: string | null; overridden: boolean };
};
export type OrganizerLinksView = {
  mode: "telegram" | "web";
  state: "open" | "closed" | "canceled";
  players: OrganizerLinkRow[];
};

export async function organizerLinksView(groupId: string, matchId: string): Promise<OrganizerLinksView | null> {
  const m = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { id: true, groupId: true, communityId: true, status: true, attendanceClosedAt: true, attendanceDeadlineAt: true } });
  if (!m) return null;
  const mode = (await attendanceMode(groupId, matchId)) ?? "web";
  const state = m.status === "CANCELED" ? "canceled" : m.status === "COMPLETED" || attendanceIsClosed(m) ? "closed" : "open";
  const ids = [...(await rosterIds(m))];
  const [players, links, rows] = await Promise.all([
    prisma.player.findMany({ where: { groupId, id: { in: ids } }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }], select: { id: true, firstName: true, lastName: true } }),
    prisma.personalAttendanceLink.findMany({ where: { matchId, groupId, revokedAt: null }, select: { playerId: true, createdAt: true, lastUsedAt: true } }),
    prisma.attendanceResponse.findMany({ where: { matchId, groupId }, select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true } }),
  ]);
  const linkBy = new Map(links.map((l) => [l.playerId, l]));
  const rowBy = new Map(rows.map((r) => [r.playerId, r as AttendanceRow]));
  const closedAt = effectiveClosedAt(m);
  return {
    mode,
    state,
    players: players.map((p) => {
      const l = linkBy.get(p.id);
      const eff = effectiveAttendance(rowBy.get(p.id), closedAt);
      return { playerId: p.id, name: fullName(p), link: l ? { createdAt: l.createdAt.toISOString(), lastUsedAt: l.lastUsedAt?.toISOString() ?? null } : null, response: { status: eff.status, source: eff.source, overridden: eff.overridden } };
    }),
  };
}

export type IssueResult =
  | { ok: true; links: Array<{ playerId: string; name: string; path: string }> }
  | { ok: false; code: "NOT_FOUND" | "TELEGRAM_MATCH" | "NOT_OPEN" | "NOT_ON_ROSTER"; error: string };

/** Create (or regenerate — the previous link stops working) personal links for roster Players. Raw tokens are returned ONCE. */
export async function issuePersonalLinks(params: { organizationId: string; groupId: string; matchId: string; userId: string; playerIds?: string[] }): Promise<IssueResult> {
  const { organizationId, groupId, matchId, userId } = params;
  const m = await prisma.match.findFirst({ where: { id: matchId, groupId }, select: { id: true, groupId: true, communityId: true, status: true, attendanceClosedAt: true, attendanceDeadlineAt: true } });
  if (!m) return { ok: false, code: "NOT_FOUND", error: "Match not found" };
  if ((await attendanceMode(groupId, matchId)) === "telegram") {
    return { ok: false, code: "TELEGRAM_MATCH", error: "This match uses the Telegram poll for attendance — players vote there, so personal links aren't used." };
  }
  if (m.status !== "SCHEDULED" || attendanceIsClosed(m)) return { ok: false, code: "NOT_OPEN", error: "Attendance for this match is closed (or the match isn't scheduled)." };
  const roster = await rosterIds(m);
  const wanted = params.playerIds ?? [...roster];
  if (wanted.some((id) => !roster.has(id))) return { ok: false, code: "NOT_ON_ROSTER", error: "A selected player isn't on this match's roster." };
  const players = await prisma.player.findMany({ where: { groupId, id: { in: wanted } }, select: { id: true, firstName: true, lastName: true }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] });
  const now = new Date();
  const issued = players.map((p) => ({ player: p, token: generateToken() }));
  await prisma.$transaction(async (tx) => {
    await tx.personalAttendanceLink.updateMany({ where: { matchId, groupId, playerId: { in: players.map((p) => p.id) }, revokedAt: null }, data: { revokedAt: now } });
    await tx.personalAttendanceLink.createMany({
      data: issued.map(({ player, token }) => ({ organizationId, groupId, matchId, playerId: player.id, tokenHash: hashToken(token), createdByUserId: userId, createdAt: now })),
    });
  });
  return { ok: true, links: issued.map(({ player, token }) => ({ playerId: player.id, name: fullName(player), path: personalLinkPath(token) })) };
}

/** Revoke a Player's active link for this Match. True when one was revoked. */
export async function revokePersonalLink(groupId: string, matchId: string, playerId: string): Promise<boolean> {
  const { count } = await prisma.personalAttendanceLink.updateMany({ where: { groupId, matchId, playerId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count > 0;
}

// ------------------------------------------------------------------ player (public, token only)

export type PersonalState = "open" | "closed" | "canceled" | "revoked" | "telegram" | "invalid";
export type PersonalView = {
  state: PersonalState;
  playerName: string;
  title: string;
  match: { date: string; kickoffLabel: string | null; timeZone: string; venue: string | null; address: string | null; deadline: string | null; deadlineLabel: string | null };
  current: { status: AttendanceStatus | null; setByOrganizer: boolean };
  serverNow: string;
};

type Resolved = {
  link: { id: string; matchId: string; groupId: string; playerId: string; revokedAt: Date | null };
  match: MatchRow & { date: Date; startTime: string | null; locationName: string | null; venue: { name: string; address: string | null } | null; community: { name: string } | null };
  group: { name: string; timezone: string; isActive: boolean };
  player: { firstName: string; lastName: string; isActive: boolean };
};

async function resolveToken(token: unknown): Promise<Resolved | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await prisma.personalAttendanceLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      matchId: true,
      groupId: true,
      playerId: true,
      revokedAt: true,
      match: { select: { id: true, groupId: true, communityId: true, status: true, attendanceClosedAt: true, attendanceDeadlineAt: true, date: true, startTime: true, locationName: true, venue: { select: { name: true, address: true } }, community: { select: { name: true } } } },
      group: { select: { name: true, timezone: true, isActive: true } },
      player: { select: { firstName: true, lastName: true, isActive: true, groupId: true } },
    },
  });
  // Defense in depth: every part must belong to the same Group.
  if (!row || row.match.groupId !== row.groupId || row.player.groupId !== row.groupId) return null;
  return { link: { id: row.id, matchId: row.matchId, groupId: row.groupId, playerId: row.playerId, revokedAt: row.revokedAt }, match: row.match, group: row.group, player: row.player };
}

async function stateOf(r: Resolved, now: Date): Promise<PersonalState> {
  if (!r.group.isActive || !r.player.isActive) return "invalid";
  if (r.link.revokedAt) return "revoked";
  if (r.match.status === "CANCELED") return "canceled";
  if (!(await rosterIds(r.match)).has(r.link.playerId)) return "invalid";
  if ((await attendanceMode(r.link.groupId, r.link.matchId)) === "telegram") return "telegram";
  if (r.match.status === "COMPLETED" || attendanceIsClosed(r.match, now)) return "closed";
  return "open";
}

function kickoffLabel(r: Resolved): string | null {
  if (!r.match.startTime) return null;
  const at = kickoffAt(r.match.date, r.match.startTime, r.group.timezone);
  return new Intl.DateTimeFormat("en-US", { timeZone: r.group.timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}

async function currentOf(r: Resolved) {
  const row = (await prisma.attendanceResponse.findUnique({
    where: { matchId_playerId: { matchId: r.link.matchId, playerId: r.link.playerId } },
    select: { playerId: true, participantStatus: true, participantSource: true, participantRespondedAt: true, overrideStatus: true, overrideAt: true },
  })) as AttendanceRow | null;
  const eff = effectiveAttendance(row, effectiveClosedAt(r.match));
  return { status: eff.status, setByOrganizer: eff.overridden };
}

/** The player's own view (only their own name and answer). null → the same generic "not valid". */
export async function personalView(token: unknown, now: Date = new Date()): Promise<PersonalView | null> {
  const r = await resolveToken(token);
  if (!r) return null;
  const state = await stateOf(r, now);
  if (state === "invalid") return null;
  const tz = r.group.timezone;
  return {
    state,
    playerName: r.player.firstName.trim() || "Player",
    title: r.match.community?.name ?? r.group.name,
    match: {
      date: r.match.date.toISOString().slice(0, 10),
      kickoffLabel: kickoffLabel(r),
      timeZone: tz,
      venue: r.match.venue?.name ?? r.match.locationName ?? null,
      address: r.match.venue?.address ?? null,
      deadline: r.match.attendanceDeadlineAt?.toISOString() ?? null,
      deadlineLabel: r.match.attendanceDeadlineAt ? formatDeadline(r.match.attendanceDeadlineAt.toISOString(), tz, now) : null,
    },
    current: await currentOf(r),
    serverNow: now.toISOString(),
  };
}

export type PersonalAnswer = { ok: true; status: AttendanceStatus; setByOrganizer: boolean } | { ok: false; reason: Exclude<PersonalState, "open"> | "rate_limited" };

/** Record the link's Player's answer (source PERSONAL_LINK). The Player comes from the link row only. */
export async function answerPersonal(token: unknown, status: AttendanceStatus, now: Date = new Date()): Promise<PersonalAnswer> {
  const r = await resolveToken(token);
  if (!r) return { ok: false, reason: "invalid" };
  const state = await stateOf(r, now);
  if (state !== "open") return { ok: false, reason: state };
  const outcome = await prisma.$transaction(async (tx): Promise<"ok" | "rate_limited" | "revoked" | "closed" | "telegram"> => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"personal-link:" + r.link.id}))`;
    // M13A — a poll posted (or a Telegram chat assigned) meanwhile makes this a Telegram match: decided under the Match row lock.
    await lockMatchForAnswer(tx, r.link.matchId);
    if ((await attendanceMode(r.link.groupId, r.link.matchId, tx)) === "telegram") return "telegram";
    const link = await tx.personalAttendanceLink.findUniqueOrThrow({ where: { id: r.link.id }, select: { revokedAt: true, windowStartedAt: true, windowCount: true } });
    if (link.revokedAt) return "revoked";
    // Re-checked inside the transaction: attendance may have closed meanwhile.
    const fresh = await tx.match.findUniqueOrThrow({ where: { id: r.link.matchId }, select: { attendanceClosedAt: true, attendanceDeadlineAt: true, status: true } });
    if (fresh.status !== "SCHEDULED" || attendanceIsClosed(fresh, now)) return "closed";
    const inWindow = link.windowStartedAt && now.getTime() - link.windowStartedAt.getTime() < LINK_ANSWER_LIMIT.windowMs;
    if (inWindow && link.windowCount >= LINK_ANSWER_LIMIT.max) return "rate_limited";
    await tx.personalAttendanceLink.update({
      where: { id: r.link.id },
      data: inWindow ? { windowCount: { increment: 1 }, lastUsedAt: now } : { windowStartedAt: now, windowCount: 1, lastUsedAt: now },
    });
    await recordParticipantResponse(tx, { matchId: r.link.matchId, groupId: r.link.groupId, playerId: r.link.playerId, status, source: "PERSONAL_LINK", at: now });
    return "ok";
  });
  if (outcome !== "ok") return { ok: false, reason: outcome };
  const current = await currentOf(r);
  return { ok: true, status, setByOrganizer: current.setByOrganizer };
}
