import { Prisma, type GroupJoinRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isWellFormedToken } from "@/lib/secureToken";
import { requireRole, type TenantContext } from "@/lib/tenantContext";
import { findSport } from "@/lib/sports";
import { insertPlayerInTx } from "@/lib/playerCrud";

/**
 * M13A — group invitations with MANUAL membership approval.
 *
 *   Player.userId stays THE player-membership relation (My Games, group pages,
 *   own attendance — src/lib/groupAccess.ts). A join request only ASKS; an
 *   OWNER/ADMIN decides: link the applicant to an existing UNCLAIMED Player of
 *   the Group, or create a new Player for them, or reject. Nothing is ever
 *   matched by name or email, and joining never creates an
 *   OrganizationMembership (no organizer or MEMBER access).
 *
 * Join link (GroupJoinLink): 32 random bytes (base64url) in the URL FRAGMENT
 * (/join#<token>) — never in a request URL, so never in access logs or
 * Referer; only its SHA-256 is stored. One active link per Group (generating
 * a new one revokes the previous), default 30-day expiry. Holding a link lets
 * a signed-in user with a VERIFIED email file one request — it reveals the
 * Group's name only (never the roster) and grants no membership, attendance or
 * claim. Revoking a link stops NEW requests; requests already filed through it
 * stay PENDING for the organizer to decide (policy: the organizer reviews each
 * one anyway; reject them if the link leaked).
 *
 * Concurrency: a request is decided under a per-request advisory lock, the
 * chosen Player under the same per-Player lock as claim links
 * ("player-claim:<id>"), and the database enforces one account per Player per
 * Group (Player @@unique([groupId, userId])) and one PENDING request per
 * (group, user) (partial unique index).
 */
export const JOIN_PATH = "/join";
export const joinLinkPath = (token: string) => `${JOIN_PATH}#${token}`;
export const JOIN_LINK_DAYS = { default: 30, min: 1, max: 90 } as const;
/** Database-backed abuse limits (Upstash is optional and absent in Production). */
export const JOIN_LIMITS = { requestsPerUserPerDay: 10, pendingPerGroup: 50 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MANAGERS = ["OWNER", "ADMIN"] as const;

const lockRequest = (tx: Prisma.TransactionClient, id: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"join-request:" + id}))`;
const lockPlayer = (tx: Prisma.TransactionClient, playerId: string) => tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"player-claim:" + playerId}))`;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

// ------------------------------------------------------------------ organizer: links

export type JoinLinkView = { id: string; createdAt: string; expiresAt: string; state: "active" | "expired" | "revoked"; pendingRequests: number };

const linkState = (l: { expiresAt: Date; revokedAt: Date | null }, now: Date): JoinLinkView["state"] => (l.revokedAt ? "revoked" : l.expiresAt <= now ? "expired" : "active");

/** OWNER/ADMIN: the Group's join links, newest first (never tokens). */
export async function listJoinLinks(context: TenantContext, now: Date = new Date()): Promise<JoinLinkView[]> {
  requireRole(context, [...MANAGERS]);
  const links = await prisma.groupJoinLink.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, _count: { select: { requests: { where: { status: "PENDING" } } } } },
  });
  return links.map((l) => ({ id: l.id, createdAt: l.createdAt.toISOString(), expiresAt: l.expiresAt.toISOString(), state: linkState(l, now), pendingRequests: l._count.requests }));
}

/** OWNER/ADMIN: a new join link (the Group's previous active link stops working). The raw token is returned ONCE. */
export async function createJoinLink(context: TenantContext, days: number = JOIN_LINK_DAYS.default, now: Date = new Date()): Promise<{ id: string; token: string; path: string; expiresAt: Date }> {
  requireRole(context, [...MANAGERS]);
  const groupId = context.activeGroup.id;
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"join-link:" + groupId}))`;
    await tx.groupJoinLink.updateMany({ where: { groupId, revokedAt: null }, data: { revokedAt: now } });
    return tx.groupJoinLink.create({ data: { organizationId: context.organization.id, groupId, tokenHash: hashToken(token), createdByUserId: context.user.id, createdAt: now, expiresAt }, select: { id: true } });
  });
  return { id: created.id, token, path: joinLinkPath(token), expiresAt };
}

/** OWNER/ADMIN: revoke one of the Group's links. False when it isn't this Group's or is already revoked. */
export async function revokeJoinLink(context: TenantContext, linkId: string, now: Date = new Date()): Promise<boolean> {
  requireRole(context, [...MANAGERS]);
  const { count } = await prisma.groupJoinLink.updateMany({ where: { id: linkId, groupId: context.activeGroup.id, revokedAt: null }, data: { revokedAt: now } });
  return count === 1;
}

// ------------------------------------------------------------------ organizer: requests

export type JoinRequestView = {
  id: string;
  firstName: string;
  lastName: string;
  /** The applicant's VERIFIED account email — organizers (OWNER/ADMIN) only. */
  email: string;
  status: GroupJoinRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  player: { id: string; name: string } | null;
};
export type AvailablePlayer = { id: string; name: string; position: string; isActive: boolean };

/** OWNER/ADMIN: pending requests first, then recent decisions; plus the Group's UNCLAIMED Players to link. */
export async function listJoinRequests(context: TenantContext): Promise<{ requests: JoinRequestView[]; availablePlayers: AvailablePlayer[] }> {
  requireRole(context, [...MANAGERS]);
  const groupId = context.activeGroup.id;
  const select = {
    id: true,
    firstName: true,
    lastName: true,
    status: true,
    createdAt: true,
    decidedAt: true,
    user: { select: { email: true } },
    decidedBy: { select: { name: true, email: true } },
    player: { select: { id: true, firstName: true, lastName: true } },
  } as const;
  const [pending, decided, players] = await Promise.all([
    prisma.groupJoinRequest.findMany({ where: { groupId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 200, select }),
    prisma.groupJoinRequest.findMany({ where: { groupId, status: { not: "PENDING" } }, orderBy: { updatedAt: "desc" }, take: 20, select }),
    prisma.player.findMany({ where: { groupId, userId: null }, orderBy: [{ isActive: "desc" }, { firstName: "asc" }, { lastName: "asc" }], select: { id: true, firstName: true, lastName: true, position: true, isActive: true } }),
  ]);
  const view = (r: (typeof pending)[number]): JoinRequestView => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.user.email,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy ? (r.decidedBy.name ?? r.decidedBy.email) : null,
    player: r.player ? { id: r.player.id, name: fullName(r.player) } : null,
  });
  return { requests: [...pending, ...decided].map(view), availablePlayers: players.map((p) => ({ id: p.id, name: fullName(p), position: p.position, isActive: p.isActive })) };
}

export type DecisionFailure = "NOT_FOUND" | "NOT_PENDING" | "PLAYER_NOT_FOUND" | "PLAYER_ALREADY_CLAIMED" | "ALREADY_MEMBER";
export type NewPlayerData = { firstName: string; lastName: string; position: string; rating: Prisma.PlayerCreateInput["rating"]; stamina?: number; isActive?: boolean; communityIds?: string[] };
export type ApproveChoice = { playerId: string } | { newPlayer: NewPlayerData };

/**
 * OWNER/ADMIN: approve a PENDING request — link the applicant to the chosen
 * UNCLAIMED Player of this Group, or create a new Player linked to them (plan
 * limits and player validation as "Add player"; throws EntitlementError /
 * CommunityChoiceError for the caller to map).
 */
export async function approveJoinRequest(context: TenantContext, requestId: string, choice: ApproveChoice, now: Date = new Date()): Promise<{ ok: true; playerId: string } | { ok: false; code: DecisionFailure }> {
  requireRole(context, [...MANAGERS]);
  const groupId = context.activeGroup.id;
  try {
    return await prisma.$transaction(async (tx): Promise<{ ok: true; playerId: string } | { ok: false; code: DecisionFailure }> => {
      await lockRequest(tx, requestId);
      const request = await tx.groupJoinRequest.findFirst({ where: { id: requestId, groupId }, select: { id: true, userId: true, status: true } });
      if (!request) return { ok: false, code: "NOT_FOUND" };
      if (request.status !== "PENDING") return { ok: false, code: "NOT_PENDING" };
      if (await tx.player.findFirst({ where: { groupId, userId: request.userId }, select: { id: true } })) return { ok: false, code: "ALREADY_MEMBER" };

      let playerId: string;
      if ("playerId" in choice) {
        await lockPlayer(tx, choice.playerId);
        const player = await tx.player.findFirst({ where: { id: choice.playerId, groupId }, select: { userId: true } });
        if (!player) return { ok: false, code: "PLAYER_NOT_FOUND" };
        if (player.userId) return { ok: false, code: "PLAYER_ALREADY_CLAIMED" };
        const { count } = await tx.player.updateMany({ where: { id: choice.playerId, groupId, userId: null }, data: { userId: request.userId } });
        if (count !== 1) return { ok: false, code: "PLAYER_ALREADY_CLAIMED" };
        // Any outstanding claim link for this Player is now pointless (as when a claim is accepted).
        await tx.playerClaim.updateMany({ where: { playerId: choice.playerId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        playerId = choice.playerId;
      } else {
        playerId = (await insertPlayerInTx(tx, context, choice.newPlayer, request.userId)).id;
      }
      await tx.groupJoinRequest.update({ where: { id: request.id }, data: { status: "APPROVED", playerId, decidedByUserId: context.user.id, decidedAt: now } });
      return { ok: true, playerId };
    });
  } catch (e) {
    // Player @@unique([groupId, userId]) — a concurrent approval / claim linked the applicant first.
    if (isUniqueViolation(e)) return { ok: false, code: "ALREADY_MEMBER" };
    throw e;
  }
}

/** OWNER/ADMIN: reject a PENDING request (nothing is created or linked). */
export async function rejectJoinRequest(context: TenantContext, requestId: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" }> {
  requireRole(context, [...MANAGERS]);
  return prisma.$transaction(async (tx) => {
    await lockRequest(tx, requestId);
    const request = await tx.groupJoinRequest.findFirst({ where: { id: requestId, groupId: context.activeGroup.id }, select: { status: true } });
    if (!request) return { ok: false as const, code: "NOT_FOUND" as const };
    if (request.status !== "PENDING") return { ok: false as const, code: "NOT_PENDING" as const };
    await tx.groupJoinRequest.update({ where: { id: requestId }, data: { status: "REJECTED", decidedByUserId: context.user.id, decidedAt: now } });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ applicant (token + session)

type ResolvedLink = { id: string; organizationId: string; groupId: string; group: { name: string; sportKey: string; organizationName: string } };
type LinkLookup = { state: "valid"; link: ResolvedLink } | { state: "expired" | "revoked" | "invalid" };

async function resolveJoinToken(token: unknown, now: Date): Promise<LinkLookup> {
  if (!isWellFormedToken(token)) return { state: "invalid" };
  const l = await prisma.groupJoinLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, organizationId: true, groupId: true, expiresAt: true, revokedAt: true, group: { select: { name: true, sportKey: true, isActive: true, organizationId: true, organization: { select: { name: true } } } } },
  });
  // Defense in depth: the link's Organization must be its Group's.
  if (!l || !l.group.isActive || l.group.organizationId !== l.organizationId) return { state: "invalid" };
  if (l.revokedAt) return { state: "revoked" };
  if (l.expiresAt <= now) return { state: "expired" };
  return { state: "valid", link: { id: l.id, organizationId: l.organizationId, groupId: l.groupId, group: { name: l.group.name, sportKey: l.group.sportKey, organizationName: l.group.organization.name } } };
}

export type ApplicantRequest = { id: string; status: GroupJoinRequestStatus; createdAt: string };
export type JoinPreview =
  | { state: "invalid" | "expired" | "revoked" }
  | {
      state: "valid";
      group: { name: string; organizationName: string; sportLabel: string };
      viewer: null | { emailVerified: boolean; email: string; name: string | null; member: boolean; request: ApplicantRequest | null };
    };

async function latestRequest(groupId: string, userId: string): Promise<ApplicantRequest | null> {
  const r = await prisma.groupJoinRequest.findFirst({ where: { groupId, userId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, createdAt: true } });
  return r ? { id: r.id, status: r.status, createdAt: r.createdAt.toISOString() } : null;
}

/**
 * What the holder of a join link may see: the Group's name, organization and
 * sport — never the roster or organizer data — plus, when signed in, their OWN
 * standing (member already / their latest request). Expired and revoked links
 * reveal nothing about the Group.
 */
export async function joinPreview(token: unknown, viewer: { id: string; email: string; name: string | null; emailVerified: boolean } | null, now: Date = new Date()): Promise<JoinPreview> {
  const r = await resolveJoinToken(token, now);
  if (r.state !== "valid") return { state: r.state };
  const { link } = r;
  const group = { name: link.group.name, organizationName: link.group.organizationName, sportLabel: findSport(link.group.sportKey)?.label ?? link.group.sportKey };
  if (!viewer) return { state: "valid", group, viewer: null };
  const member = Boolean(await prisma.player.findFirst({ where: { groupId: link.groupId, userId: viewer.id }, select: { id: true } }));
  return { state: "valid", group, viewer: { emailVerified: viewer.emailVerified, email: viewer.email, name: viewer.name, member, request: await latestRequest(link.groupId, viewer.id) } };
}

export type SubmitFailure = "INVITE_INVALID" | "INVITE_EXPIRED" | "INVITE_REVOKED" | "ALREADY_MEMBER" | "ALREADY_PENDING" | "RATE_LIMITED" | "TOO_MANY_PENDING";

/** A signed-in, VERIFIED user (caller resolves via requireSessionUser) asks to join the link's Group. */
export async function submitJoinRequest(
  user: { id: string },
  token: unknown,
  names: { firstName: string; lastName: string },
  now: Date = new Date()
): Promise<{ ok: true; request: ApplicantRequest } | { ok: false; code: SubmitFailure }> {
  const r = await resolveJoinToken(token, now);
  if (r.state !== "valid") return { ok: false, code: r.state === "expired" ? "INVITE_EXPIRED" : r.state === "revoked" ? "INVITE_REVOKED" : "INVITE_INVALID" };
  const { link } = r;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"join-user:" + user.id}))`;
      if (await tx.player.findFirst({ where: { groupId: link.groupId, userId: user.id }, select: { id: true } })) return { ok: false as const, code: "ALREADY_MEMBER" as const };
      if (await tx.groupJoinRequest.findFirst({ where: { groupId: link.groupId, userId: user.id, status: "PENDING" }, select: { id: true } })) return { ok: false as const, code: "ALREADY_PENDING" as const };
      const recent = await tx.groupJoinRequest.count({ where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - DAY_MS) } } });
      if (recent >= JOIN_LIMITS.requestsPerUserPerDay) return { ok: false as const, code: "RATE_LIMITED" as const };
      const pending = await tx.groupJoinRequest.count({ where: { groupId: link.groupId, status: "PENDING" } });
      if (pending >= JOIN_LIMITS.pendingPerGroup) return { ok: false as const, code: "TOO_MANY_PENDING" as const };
      const created = await tx.groupJoinRequest.create({
        data: { organizationId: link.organizationId, groupId: link.groupId, userId: user.id, joinLinkId: link.id, firstName: names.firstName, lastName: names.lastName, createdAt: now },
        select: { id: true, status: true, createdAt: true },
      });
      return { ok: true as const, request: { id: created.id, status: created.status, createdAt: created.createdAt.toISOString() } };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: "ALREADY_PENDING" }; // the partial unique index
    throw e;
  }
}

/** The applicant cancels their OWN pending request. */
export async function cancelJoinRequest(userId: string, requestId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.groupJoinRequest.updateMany({ where: { id: requestId, userId, status: "PENDING" }, data: { status: "CANCELED", decidedAt: now } });
  return count === 1;
}

export type MyJoinRequest = { id: string; groupName: string; organizationName: string; status: GroupJoinRequestStatus; createdAt: string };

/** /me — the user's own pending requests and recent (30-day) outcomes (no organizer data). */
export async function listMyJoinRequests(userId: string, now: Date = new Date()): Promise<MyJoinRequest[]> {
  const rows = await prisma.groupJoinRequest.findMany({
    where: { userId, group: { isActive: true }, OR: [{ status: "PENDING" }, { status: { in: ["APPROVED", "REJECTED"] }, decidedAt: { gt: new Date(now.getTime() - 30 * DAY_MS) } }] },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, status: true, createdAt: true, group: { select: { name: true, organization: { select: { name: true } } } } },
  });
  return rows.map((r) => ({ id: r.id, groupName: r.group.name, organizationName: r.group.organization.name, status: r.status, createdAt: r.createdAt.toISOString() }));
}
