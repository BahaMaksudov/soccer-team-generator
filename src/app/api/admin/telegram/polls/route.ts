import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const polls = await prisma.telegramPoll.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      pollId: true,
      chatId: true,
      messageId: true,
      question: true,
      optionsJson: true,
      isClosed: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ polls });
}
