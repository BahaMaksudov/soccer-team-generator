import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { telegramCreatePollSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

async function telegram(method: string, body: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.description || "Telegram API error");
  return data.result;
}

function formatMdyTwoDigitYear(ymd: string) {
  // ymd = YYYY-MM-DD -> M/D/YY (no leading zeros)
  const [y, m, d] = ymd.split("-").map(Number);
  const yy = String(y).slice(-2);
  return `${m}/${d}/${yy}`;
}

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = telegramCreatePollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { chatId: chatIdStr, pollDate: pollDateStr, question: customQuestion } = parsed.data;

  // Ownership validation BEFORE any Telegram side effect: the selected
  // chat must already be a registered chat belonging to the caller's
  // active Group. Previously sendPoll fired first, with no ownership
  // check at all — a client could submit any chatId, including
  // another tenant's, and a real poll would be sent there before
  // anything was verified. 404, not 403 — never reveal that a foreign
  // chat exists.
  let chatIdBigInt: bigint;
  try {
    chatIdBigInt = BigInt(chatIdStr);
  } catch {
    return NextResponse.json({ error: "chatId must be a valid Telegram chat id" }, { status: 400 });
  }

  const chat = await prisma.telegramChat.findFirst({
    where: { chatId: chatIdBigInt, groupId: activeGroupId },
    select: { chatId: true },
  });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  try {
    // Convert to DateTime for Prisma (Date at 00:00 UTC)
    const pollDate = toDateOnlyUTC(pollDateStr);

    const display = formatMdyTwoDigitYear(pollDateStr);
    const question = customQuestion?.trim() || `Who is playing on ${display}?`;
    const options = ["✅ Playing", "❌ Not playing"];

    // sendPoll returns a Message object (includes message_id and poll.id)
    const msg = await telegram("sendPoll", {
      chat_id: chatIdStr,
      question,
      options,
      is_anonymous: false,
      allows_multiple_answers: false,
    });

    const pollId = msg?.poll?.id;
    const messageId = msg?.message_id;

    if (!pollId || !messageId) {
      return NextResponse.json(
        { error: "Telegram sendPoll succeeded but pollId/messageId missing" },
        { status: 500 }
      );
    }

    await prisma.telegramPoll.upsert({
      where: { pollId: String(pollId) },
      update: {
        chatId: chatIdBigInt,
        messageId: BigInt(messageId),
        question,
        optionsJson: JSON.stringify(options),
        pollDate,
        isClosed: false,
        groupId: activeGroupId,
      },
      create: {
        pollId: String(pollId),
        chatId: chatIdBigInt,
        messageId: BigInt(messageId),
        question,
        optionsJson: JSON.stringify(options),
        pollDate,
        isClosed: false,
        groupId: activeGroupId,
      },
    });

    return NextResponse.json({ ok: true, pollId: String(pollId), messageId });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
