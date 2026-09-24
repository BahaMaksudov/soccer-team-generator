import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePollDisplayDate, resolvePollCalendarDate } from "@/lib/telegramFormat";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

export async function GET(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

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
      // Source of truth for both is the pollDate column; both fall back
      // to parsing the question text only for legacy rows with no
      // pollDate set. Two distinct fields, two distinct purposes:
      //   pollDate    — machine-readable "YYYY-MM-DD", for populating
      //                 a <input type="date"> / previewDate.
      //   pollDateStr — human-readable "M/D/YY", for display only.
      pollDate: resolvePollCalendarDate(p),
      pollDateStr: resolvePollDisplayDate(p, null),
    };
  });

  return NextResponse.json({ polls: items });
}
