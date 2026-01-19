import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {

    try{
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

// Collect unique chatIds from polls
const chatIds = Array.from(
    new Set(
      polls
        .map((p) => (p.chatId != null ? p.chatId.toString() : ""))
        .filter(Boolean)
    )
  );

  // Pull titles from TelegramChat (you already have title saved)
  const chats = await prisma.telegramChat.findMany({
    where: { chatId: { in: chatIds.map((x) => BigInt(x)) } },
    select: { chatId: true, title: true },
  });

  const titleByChatId = new Map(
    chats.map((c) => [c.chatId.toString(), c.title ?? "Unknown group"] as const)
  );

  const items = polls.map((p) => {
    const chatIdStr = p.chatId?.toString() ?? "";
    return {
      pollId: p.pollId,
      chatId: chatIdStr,
      chatTitle: titleByChatId.get(chatIdStr) ?? `Chat ${chatIdStr}`,
      question: p.question ?? "",
      pollDate: p.pollDate ? p.pollDate.toISOString().slice(0, 10) : null, // YYYY-MM-DD
      isClosed: Boolean(p.isClosed),
      createdAt: p.createdAt ? p.createdAt.toISOString() : null,
    };
  });

  return NextResponse.json({ polls: items });
  //   return NextResponse.json({ polls });
} catch (e: any) {
  return NextResponse.json(
    { error: String(e?.message ?? e) },
    { status: 500 }
  );
}


}


// import { NextResponse } from "next/server";
// import { prisma } from "@/lib/prisma";

// export async function GET() {
//   try {
//     // Pull recent polls (adjust take/order as you like)
//     const polls = await prisma.telegramPoll.findMany({
//       orderBy: { createdAt: "desc" }, // requires createdAt in model (you have it)
//       take: 50,
//       select: {
//         pollId: true,
//         chatId: true,
//         question: true,
//         pollDate: true,
//         isClosed: true,
//         createdAt: true,
//       },
//     });

//     // Get chat titles
//     const chatIds = Array.from(
//       new Set(polls.map((p) => p.chatId?.toString()).filter(Boolean))
//     ) as string[];

//     const chats = await prisma.telegramChat.findMany({
//       where: { chatId: { in: chatIds.map((x) => BigInt(x)) } },
//       select: { chatId: true, title: true },
//     });

//     const chatTitleById = new Map(
//       chats.map((c) => [c.chatId.toString(), c.title ?? "Unknown group"] as const)
//     );

//     const items = polls.map((p) => {
//       const chatIdStr = p.chatId?.toString() ?? "";
//       return {
//         pollId: p.pollId,
//         chatId: chatIdStr,
//         chatTitle: chatTitleById.get(chatIdStr) ?? `Chat ${chatIdStr}`,
//         question: p.question ?? "",
//         pollDate: p.pollDate ? p.pollDate.toISOString().slice(0, 10) : null, // YYYY-MM-DD
//         isClosed: Boolean(p.isClosed),
//         createdAt: p.createdAt?.toISOString?.() ?? null,
//       };
//     });

//     return NextResponse.json({ polls: items });
//   } catch (e: any) {
//     return NextResponse.json(
//       { error: String(e?.message ?? e) },
//       { status: 500 }
//     );
//   }
// }
