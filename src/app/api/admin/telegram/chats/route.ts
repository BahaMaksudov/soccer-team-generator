import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const chats = await prisma.telegramChat.findMany({
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
