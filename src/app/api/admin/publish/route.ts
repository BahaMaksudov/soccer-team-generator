// import { prisma } from "@/lib/prisma";
// import { NextResponse } from "next/server";
// import { toDateOnlyUTC } from "@/lib/dateOnly";
// import { revalidatePath } from "next/cache";

// export async function POST(req: Request) {
//   const body = await req.json();

//   const dateStr = String(body.date ?? "");
//   const teams = body.teams;

//   if (!dateStr) {
//     return NextResponse.json({ error: "Date is required." }, { status: 400 });
//   }
//   if (!Array.isArray(teams) || teams.length === 0) {
//     return NextResponse.json({ error: "Teams are required." }, { status: 400 });
//   }

//   const normalizedDate = toDateOnlyUTC(dateStr);

//   const saved = await prisma.teamGeneration.upsert({
//     where: { date: normalizedDate },
//     create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
//     update: { teamsJson: JSON.stringify(teams) },
//   });

//   // Home page likely reads published teams
//   revalidatePath("/");

//   return NextResponse.json({ ok: true, id: saved.id });
// }

// export async function DELETE(req: Request) {
//   const url = new URL(req.url);
//   const dateStr = url.searchParams.get("date");

//   if (!dateStr) {
//     return NextResponse.json({ error: "date query param is required (YYYY-MM-DD)" }, { status: 400 });
//   }

//   // Delete everything in that UTC day (covers any stored time within the day)
//   const start = toDateOnlyUTC(dateStr);
//   const end = new Date(start);
//   end.setUTCDate(end.getUTCDate() + 1);

//   const result = await prisma.teamGeneration.deleteMany({
//     where: {
//       date: {
//         gte: start,
//         lt: end,
//       },
//     },
//   });

//   revalidatePath("/");

//   return NextResponse.json({ ok: true, deleted: result.count, start, end });
// }


import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";

async function telegram(method: string, body: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    throw new Error(data?.description || "Telegram API error");
  }
  return data.result;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const dateStr = String(body.date ?? "");
  const teams = body.teams;

  // ✅ NEW: optional poll close after publish
  const pollId = body.pollId ? String(body.pollId) : "";
  const closePoll = body.closePoll !== false; // default true

  if (!dateStr) {
    return NextResponse.json({ error: "Date is required." }, { status: 400 });
  }
  if (!Array.isArray(teams) || teams.length === 0) {
    return NextResponse.json({ error: "Teams are required." }, { status: 400 });
  }

  const normalizedDate = toDateOnlyUTC(dateStr);

  const saved = await prisma.teamGeneration.upsert({
    where: { date: normalizedDate },
    create: { date: normalizedDate, teamsJson: JSON.stringify(teams) },
    update: { teamsJson: JSON.stringify(teams) },
  });

  // ✅ Close telegram poll if requested
  if (pollId && closePoll) {
    const poll = await prisma.telegramPoll.findUnique({ where: { pollId } });

    if (poll?.chatId && poll?.messageId) {
      // Telegram expects message_id as number
      await telegram("stopPoll", {
        chat_id: poll.chatId.toString(),
        message_id: Number(poll.messageId),
      });

      await prisma.telegramPoll.update({
        where: { pollId },
        data: { isClosed: true },
      });
    }
  }

  // Home page likely reads published teams
  revalidatePath("/");

  return NextResponse.json({ ok: true, id: saved.id });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const dateStr = url.searchParams.get("date");

  if (!dateStr) {
    return NextResponse.json(
      { error: "date query param is required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  // Delete everything in that UTC day (covers any stored time within the day)
  const start = toDateOnlyUTC(dateStr);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const result = await prisma.teamGeneration.deleteMany({
    where: {
      date: {
        gte: start,
        lt: end,
      },
    },
  });

  revalidatePath("/");

  return NextResponse.json({ ok: true, deleted: result.count, start, end });
}
