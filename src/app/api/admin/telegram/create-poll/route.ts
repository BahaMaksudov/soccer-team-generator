import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";

async function telegram(method: string, body: any) {
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
  try {
    const body = await req.json().catch(() => ({}));

    const chatId = String(body.chatId ?? "").trim();
    const pollDate = String(body.pollDate ?? "").trim(); // YYYY-MM-DD
    const customQuestion = body.question ? String(body.question) : "";

    if (!chatId) return NextResponse.json({ error: "chatId is required" }, { status: 400 });
    if (!pollDate) return NextResponse.json({ error: "pollDate is required (YYYY-MM-DD)" }, { status: 400 });

    const display = formatMdyTwoDigitYear(pollDate);
    const question = customQuestion?.trim() || `Who is playing on ${display}?`;

    const options = ["✅ Playing", "❌ Not playing"];

    // sendPoll returns a Message object (includes message_id and poll.id)
    const msg = await telegram("sendPoll", {
      chat_id: chatId,
      question,
      options,
      is_anonymous: false,
      allows_multiple_answers: false,
    });

    const pollId = msg?.poll?.id;
    const messageId = msg?.message_id;

    if (!pollId || !messageId) {
      return NextResponse.json({ error: "Telegram sendPoll succeeded but pollId/messageId missing" }, { status: 500 });
    }

    await prisma.telegramPoll.upsert({
      where: { pollId: String(pollId) },
      update: {
        chatId: BigInt(chatId),
        messageId: BigInt(messageId),
        question,
        pollDate: toDateOnlyUTC(pollDate),
        isClosed: false,
      },
      create: {
        pollId: String(pollId),
        chatId: BigInt(chatId),
        messageId: BigInt(messageId),
        question,
        pollDate: toDateOnlyUTC(pollDate),
        isClosed: false,
      },
    });

    return NextResponse.json({ ok: true, pollId: String(pollId), messageId });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
