import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenantContext";
import { managersOnlyResponse } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M9.2 — Communities: provider-neutral rosters of a Group.
 *
 * A Community belongs to exactly one Group (composite keys make a cross-Group
 * membership, channel or Match impossible in the database). A Player is never
 * duplicated per community: CommunityPlayer is a membership row. Communication
 * channels (Telegram today) attach to a Community; the roster never lives on
 * the channel. Communities are deactivated, never deleted.
 *
 * Every id from the browser is resolved inside the URL-bound Group (foreign /
 * unknown == the same 404). Reads are open to members of the Group (names and
 * membership only — never skill/stamina); every change is OWNER/ADMIN.
 */

const notFound = (what: string) => NextResponse.json({ error: `${what} not found` }, { status: 404 });

export const communityNameSchema = z.string().trim().min(1, "Community name is required.").max(80, "Keep the name under 80 characters.");
export const createCommunitySchema = z.object({ name: communityNameSchema });
export const updateCommunitySchema = z.object({ name: communityNameSchema.optional(), isActive: z.boolean().optional() }).refine((v) => v.name !== undefined || v.isActive !== undefined, { message: "Nothing to change." });
export const communityPlayerSchema = z.object({ playerId: z.string().trim().min(1).max(64) });

/** A Community of THIS Group (null when foreign/unknown). */
export async function groupCommunity(groupId: string, communityId: string, activeOnly = false) {
  if (typeof communityId !== "string" || !communityId || communityId.length > 64) return null;
  return prisma.community.findFirst({
    where: { id: communityId, groupId, ...(activeOnly ? { isActive: true } : {}) },
    select: { id: true, name: true, isActive: true },
  });
}

/** Player ids that are members of a Community (any active state; callers filter by Player.isActive). */
export async function communityMemberIds(groupId: string, communityId: string): Promise<string[]> {
  const rows = await prisma.communityPlayer.findMany({ where: { groupId, communityId }, select: { playerId: true } });
  return rows.map((r) => r.playerId);
}

/** The eligible roster of a Community: ACTIVE Players who are members. */
export async function communityRosterIds(groupId: string, communityId: string): Promise<string[]> {
  const rows = await prisma.communityPlayer.findMany({
    where: { groupId, communityId, player: { isActive: true } },
    select: { playerId: true },
  });
  return rows.map((r) => r.playerId);
}

/**
 * M9.2 — server-side roster enforcement: of `playerIds`, the ones that are NOT
 * members of the Community (empty = all members). Used by Generate and Publish
 * for a Community Match, so a browser can never put another roster's Player
 * into a Match's teams.
 */
export async function idsOutsideCommunity(groupId: string, communityId: string, playerIds: string[]): Promise<string[]> {
  const rows = await prisma.communityPlayer.findMany({ where: { groupId, communityId, playerId: { in: playerIds } }, select: { playerId: true } });
  const ok = new Set(rows.map((r) => r.playerId));
  return playerIds.filter((id) => !ok.has(id));
}

export const OUTSIDE_COMMUNITY_MESSAGE = "One or more selected players are not in this match's community.";

/**
 * The Community a Telegram chat of this Group belongs to — attaching a new
 * Community (named after the chat) when the chat has none yet (every chat
 * bound before M9.2 was given one by the migration; this covers any other row).
 */
export async function ensureChatCommunity(groupId: string, chatRef: number): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"chat-community:" + chatRef}))`;
    const chat = await tx.telegramChat.findFirst({ where: { id: chatRef, groupId }, select: { id: true, title: true, communityId: true, disconnectedAt: true } });
    if (!chat) return null;
    if (chat.communityId) return chat.communityId;
    const community = await tx.community.create({ data: { groupId, name: chat.title || "Telegram group", isActive: chat.disconnectedAt === null }, select: { id: true } });
    await tx.telegramChat.update({ where: { id: chat.id }, data: { communityId: community.id } });
    return community.id;
  });
}

/** The connected Telegram chat of a Community (oldest first), if any. */
export async function communityTelegramChat(groupId: string, communityId: string) {
  return prisma.telegramChat.findFirst({
    where: { groupId, communityId, disconnectedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, chatId: true, title: true },
  });
}

export type CommunitySummary = { id: string; name: string; isActive: boolean; memberCount: number; telegram: Array<{ ref: number; title: string; connected: boolean }> };

/** Members of the Group: the Group's Communities (managers also see the attached Telegram chats). */
export async function listCommunities(context: TenantContext): Promise<NextResponse> {
  const groupId = context.activeGroup.id;
  const manager = context.membership.role === "OWNER" || context.membership.role === "ADMIN";
  const rows = await prisma.community.findMany({
    where: { groupId },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      isActive: true,
      _count: { select: { players: true } },
      telegramChats: { select: { id: true, title: true, disconnectedAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  const communities: CommunitySummary[] = rows.map((c) => ({
    id: c.id,
    name: c.name,
    isActive: c.isActive,
    memberCount: c._count.players,
    telegram: manager ? c.telegramChats.map((t) => ({ ref: t.id, title: t.title || "Telegram group", connected: t.disconnectedAt === null })) : [],
  }));
  const memberships = await prisma.communityPlayer.findMany({ where: { groupId }, select: { communityId: true, playerId: true } });
  return NextResponse.json({ communities, memberships });
}

export async function createCommunity(context: TenantContext, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = createCommunitySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const row = await prisma.community.create({ data: { groupId: context.activeGroup.id, name: parsed.data.name }, select: { id: true, name: true, isActive: true } });
  return NextResponse.json({ ok: true, community: row }, { status: 201 });
}

export async function updateCommunity(context: TenantContext, communityId: string, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = updateCommunitySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const community = await groupCommunity(groupId, communityId);
  if (!community) return notFound("Community");
  await prisma.community.updateMany({ where: { id: community.id, groupId }, data: parsed.data });
  return NextResponse.json({ ok: true });
}

/** OWNER/ADMIN: add (idempotent) or remove one Player of this Group to/from a Community. Never touches the Player. */
export async function changeCommunityMembership(context: TenantContext, communityId: string, req: Request, action: "add" | "remove"): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = communityPlayerSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const community = await groupCommunity(groupId, communityId);
  if (!community) return notFound("Community");
  const player = await prisma.player.findFirst({ where: { id: parsed.data.playerId, groupId }, select: { id: true } });
  if (!player) return notFound("Player");
  if (action === "remove") {
    await prisma.communityPlayer.deleteMany({ where: { groupId, communityId: community.id, playerId: player.id } });
    return NextResponse.json({ ok: true });
  }
  try {
    await prisma.communityPlayer.create({ data: { groupId, communityId: community.id, playerId: player.id, createdByUserId: context.user.id } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; // already a member → no-op
  }
  return NextResponse.json({ ok: true });
}

/** OWNER/ADMIN: attach a Telegram chat of this Group to a Community of this Group (the chat's roster becomes that Community's). */
export async function setTelegramChatCommunity(context: TenantContext, ref: number, req: Request): Promise<NextResponse> {
  const denied = managersOnlyResponse(context);
  if (denied) return denied;
  const parsed = z.object({ communityId: z.string().trim().min(1).max(64) }).safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const groupId = context.activeGroup.id;
  const chat = await prisma.telegramChat.findFirst({ where: { id: ref, groupId }, select: { id: true } });
  if (!chat) return notFound("Telegram group");
  const community = await groupCommunity(groupId, parsed.data.communityId, true);
  if (!community) return notFound("Community");
  await prisma.telegramChat.updateMany({ where: { id: chat.id, groupId }, data: { communityId: community.id } });
  return NextResponse.json({ ok: true });
}
