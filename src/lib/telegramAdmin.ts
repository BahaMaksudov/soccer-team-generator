import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { resolvePollDisplayDate, resolvePollCalendarDate } from "@/lib/telegramFormat";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.5B — shared Telegram READ core, extracted verbatim from
 * the legacy /api/admin/telegram/chats, /polls, and /users route
 * bodies (only the tenant resolution step was removed). Both the
 * legacy flat routes (requireTenantContext()) and the new canonical
 * URL-bound routes (requireTenantContextForSlugs()) delegate here
 * after independently resolving and authorizing their own
 * TenantContext — this module never resolves tenancy itself and never
 * reads request body/query for ownership, only context.activeGroup.id.
 *
 * Deliberately read-only: no function here calls the Telegram Bot API
 * or writes to any Telegram-owned table. Poll creation, import,
 * linking, and the Publish close/post branch remain out of scope for
 * this phase and are NOT extracted here yet.
 */

export async function listTelegramChatsForContext(context: TenantContext): Promise<NextResponse> {
  const chats = await prisma.telegramChat.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: { updatedAt: "desc" },
    select: { chatId: true, title: true },
  });

  return NextResponse.json({
    chats: chats.map((c) => ({
      chatId: c.chatId.toString(),
      title: c.title ?? "",
    })),
  });
}

export async function listTelegramPollsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  const polls = await prisma.telegramPoll.findMany({
    where: {
      groupId: context.activeGroup.id,
      ...(includeClosed ? {} : { isClosed: false }),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      pollId: true,
      chatId: true,
      question: true,
      pollDate: true,
      isClosed: true,
      createdAt: true,
    },
  });

  const chatIds = Array.from(new Set(polls.map((p) => p.chatId.toString())));

  const chats = await prisma.telegramChat.findMany({
    where: { chatId: { in: chatIds.map((id) => BigInt(id)) } },
    select: { chatId: true, title: true },
  });

  const titleByChatId = new Map<string, string>();
  for (const c of chats) {
    titleByChatId.set(c.chatId.toString(), c.title ?? "");
  }

  const items = polls.map((p) => {
    const chatIdStr = p.chatId.toString();
    return {
      pollId: p.pollId,
      chatId: chatIdStr,
      chatTitle: titleByChatId.get(chatIdStr) || `Chat ${chatIdStr}`,
      question: p.question ?? "",
      isClosed: Boolean(p.isClosed),
      createdAt: p.createdAt ? p.createdAt.toISOString() : null,
      pollDate: resolvePollCalendarDate(p),
      pollDateStr: resolvePollDisplayDate(p, null),
    };
  });

  return NextResponse.json({ polls: items });
}

export async function listUnlinkedTelegramUsersForContext(context: TenantContext): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const users = await prisma.telegramPollAnswer.findMany({
    where: { groupId: activeGroupId },
    distinct: ["userId"],
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const linked = await prisma.telegramUserLink.findMany({
    where: { groupId: activeGroupId },
    select: { userId: true },
  });

  const linkedSet = new Set(linked.map((l) => l.userId.toString()));

  const unlinked = users
    .filter((u) => !linkedSet.has(u.userId.toString()))
    .map((u) => ({
      userId: u.userId.toString(),
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
    }));

  return NextResponse.json(unlinked);
}
