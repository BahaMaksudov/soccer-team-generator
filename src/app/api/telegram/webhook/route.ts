// import { NextRequest, NextResponse } from "next/server";
// import { prisma } from "@/lib/prisma";
// import { toDateOnlyUTC } from "@/lib/dateOnly";


// function nextMondayDate(base = new Date()) {
//     // We want: if today is Monday -> today, else next Monday.
//     const d = new Date(base);
//     d.setHours(0, 0, 0, 0);
  
//     const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
//     const daysUntilMonday = (8 - day) % 7; // Sun->1, Mon->0, Tue->6, etc.
//     d.setDate(d.getDate() + daysUntilMonday);
  
//     return d;
//   }
  
//   function formatMDYY(d: Date) {
//     const m = d.getMonth() + 1;
//     const day = d.getDate();
//     const yy = String(d.getFullYear()).slice(-2);
//     return `${m}/${day}/${yy}`;
//   }
  

// // Telegram sends JSON updates here
// export async function POST(req: NextRequest) {
//   // Simple shared-secret verification (recommended)
//   const secret = req.headers.get("x-telegram-bot-api-secret-token") || "";
//   if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
//     return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
//   }

//   const update = await req.json().catch(() => null);
//   if (!update) return NextResponse.json({ ok: true });

//   // 1) Handle commands like /poll and /link
//   if (update.message) {
//     await handleMessage(update.message);
//   }

//   // 2) Handle votes (non-anonymous poll)
//   if (update.poll_answer) {
//     await handlePollAnswer(update.poll_answer);
//   }

//   // 3) Handle poll object updates (optional)
//   if (update.poll) {
//     await handlePoll(update.poll);
//   }

//   return NextResponse.json({ ok: true });
// }

// async function handleMessage(message: any) {
//   const text: string = message.text || "";
//   const chatId = BigInt(message.chat?.id);
//   const from = message.from || {};

//   // Normalize command (Telegram sometimes includes @BotName)
//   const cmd = text.split(" ")[0].replace(/@\w+$/, "");
//   const args = text.split(" ").slice(1);

//   if (text === "/chatid") {
//     const chatId = msg.chat.id;
//     const title =
//       msg.chat.title ||
//       [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ||
//       "Unknown chat";
  
//     // 1️⃣ Reply in Telegram so you SEE it worked
//     await telegram("sendMessage", {
//       chat_id: chatId,
//       text: `✅ Chat registered\n\nTitle: ${title}\nchatId: ${chatId}`,
//     });
  
//     // 2️⃣ Save chatId in DB (for dropdown later)
//     await prisma.telegramChat.upsert({
//       where: { chatId: BigInt(chatId) },
//       update: { title },
//       create: {
//         chatId: BigInt(chatId),
//         title,
//       },
//     });
  
//     return NextResponse.json({ ok: true });
//   }
  

//   if (cmd === "/poll") {
//     // Create a standard poll
//     // You can customize question/options
//     const nextMon = nextMondayDate(new Date());
//     const question = `Who is playing on ${formatMDYY(nextMon)}?`;
//     const options = ["✅ Playing", "❌ Not playing"];

//     const resp = await telegram("sendPoll", {
//       chat_id: chatId.toString(),
//       question,
//       options,
//       is_anonymous: false,
//       allows_multiple_answers: false,
//     });

//     const nextMon = nextMondayDate(new Date());

//     // ✅ store the same date the poll question shows
//     const pollDate = toDateOnlyUTC(nextMon);

//     // Store poll in DB
//     const poll = resp.poll;
//     await prisma.telegramPoll.upsert({
//       where: { pollId: poll.id },
//       update: {
//         chatId,
//         messageId: BigInt(resp.message_id),
//         question: poll.question,
//         optionsJson: JSON.stringify(poll.options),
//         isClosed: Boolean(poll.is_closed),

//         pollDate,

//       },
//       create: {
//         pollId: poll.id,
//         chatId,
//         messageId: BigInt(resp.message_id),
//         question: poll.question,
//         optionsJson: JSON.stringify(poll.options),
//         isClosed: Boolean(poll.is_closed),

//         pollDate,

//       },
//     });

//     return;
//   }

//   if (cmd === "/link") {
//     // /link 1234  (1234 is a short code you show in Admin next to player)
//     // We'll implement linking by "player id" instead (simpler + safer):
//     // /link <playerId>
//     const playerId = args[0];
//     if (!playerId) {
//       await telegram("sendMessage", {
//         chat_id: chatId.toString(),
//         text: "Usage: /link <playerId>\nAsk admin for your Player ID from the website.",
//       });
//       return;
//     }

//     const telegramUserId = BigInt(from.id);
//     const username = from.username ? String(from.username) : null;

//     try {
//       const updated = await prisma.player.update({
//         where: { id: playerId },
//         data: {
//           telegramUserId,
//           telegramUsername: username ?? undefined,
//         },
//       });

//       await telegram("sendMessage", {
//         chat_id: chatId.toString(),
//         text: `✅ Linked Telegram user to player: ${updated.firstName} ${updated.lastName}`,
//       });
//     } catch {
//       await telegram("sendMessage", {
//         chat_id: chatId.toString(),
//         text: "❌ Could not link. Check the playerId and try again.",
//       });
//     }
//   }

// }

// async function handlePollAnswer(pollAnswer: any) {
//   const pollId: string = pollAnswer.poll_id;
//   const user = pollAnswer.user || {};
//   const userId = BigInt(user.id);
//   const optionIds: number[] = Array.isArray(pollAnswer.option_ids) ? pollAnswer.option_ids : [];

//   await prisma.telegramPollAnswer.upsert({
//     where: { pollId_userId: { pollId, userId } },
//     update: {
//       username: user.username ? String(user.username) : undefined,
//       firstName: user.first_name ? String(user.first_name) : undefined,
//       lastName: user.last_name ? String(user.last_name) : undefined,
//       optionIdsJson: JSON.stringify(optionIds),
//     },
//     create: {
//       pollId,
//       userId,
//       username: user.username ? String(user.username) : undefined,
//       firstName: user.first_name ? String(user.first_name) : undefined,
//       lastName: user.last_name ? String(user.last_name) : undefined,
//       optionIdsJson: JSON.stringify(optionIds),
//     },
//   });
// }

// async function handlePoll(poll: any) {
//   // Optional: track closed/open status
//   await prisma.telegramPoll.updateMany({
//     where: { pollId: poll.id },
//     data: { isClosed: Boolean(poll.is_closed) },
//   });
// }

// async function telegram(method: string, body: any) {
//   const token = process.env.TELEGRAM_BOT_TOKEN;
//   if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

//   const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(body),
//   });
//   const data = await res.json();
//   if (!data.ok) throw new Error(data.description || "Telegram API error");
//   return data.result;
// }


import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toDateOnlyUTC } from "@/lib/dateOnly";


function nextMondayDate(base = new Date()) {
    // We want: if today is Monday -> today, else next Monday.
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
  
    const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
    const daysUntilMonday = (8 - day) % 7; // Sun->1, Mon->0, Tue->6, etc.
    d.setDate(d.getDate() + daysUntilMonday);
  
    return d;
  }
  
  function formatMDYY(d: Date) {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const yy = String(d.getFullYear()).slice(-2);
    return `${m}/${day}/${yy}`;
  }
  

// Telegram sends JSON updates here
export async function POST(req: NextRequest) {
  // Simple shared-secret verification (recommended)
  const secret = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const update = await req.json().catch(() => null);
  if (!update) return NextResponse.json({ ok: true });

  // 1) Handle commands like /poll and /link
  if (update.message) {
    await handleMessage(update.message);
  }

  // 2) Handle votes (non-anonymous poll)
  if (update.poll_answer) {
    await handlePollAnswer(update.poll_answer);
  }

  // 3) Handle poll object updates (optional)
  if (update.poll) {
    await handlePoll(update.poll);
  }

  return NextResponse.json({ ok: true });
}

async function handleMessage(message: any) {
  const text: string = message.text || "";
  const chatId = BigInt(message.chat?.id);
  const from = message.from || {};

  // Normalize command (Telegram sometimes includes @BotName)
  const cmd = text.split(" ")[0].replace(/@\w+$/, "");
  const args = text.split(" ").slice(1);

  if (text === "/chatid") {
    const chatId = message.chat.id;
    const title =
    message.chat.title ||
      [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") ||
      "Unknown chat";
  
    // 1️⃣ Reply in Telegram so you SEE it worked
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `✅ Chat registered\n\nTitle: ${title}\nchatId: ${chatId}`,
    });
  
    // 2️⃣ Save chatId in DB (for dropdown later)
    await prisma.telegramChat.upsert({
      where: { chatId: BigInt(chatId) },
      update: { title },
      create: {
        chatId: BigInt(chatId),
        title,
      },
    });
  
    return NextResponse.json({ ok: true });
  }
  
  if (cmd === "/poll") {
    // Create a standard poll
    const nextMon = nextMondayDate(new Date());
    const question = `Who is playing on ${formatMDYY(nextMon)}?`;
    const options = ["✅ Playing", "❌ Not playing"];
  
    const resp = await telegram("sendPoll", {
      chat_id: chatId.toString(),
      question,
      options,
      is_anonymous: false,
      allows_multiple_answers: false,
    });
  
    // ✅ store the same date the poll question shows
    const pollDate = toDateOnlyUTC(nextMon);
  
    // Store poll in DB
    const poll = resp.poll;
    await prisma.telegramPoll.upsert({
      where: { pollId: poll.id },
      update: {
        chatId,
        messageId: BigInt(resp.message_id),
        question: poll.question,
        optionsJson: JSON.stringify(poll.options),
        isClosed: Boolean(poll.is_closed),
        pollDate,
      },
      create: {
        pollId: poll.id,
        chatId,
        messageId: BigInt(resp.message_id),
        question: poll.question,
        optionsJson: JSON.stringify(poll.options),
        isClosed: Boolean(poll.is_closed),
        pollDate,
      },
    });
  
    return;
  }
  

//   if (cmd === "/poll") {
//     // Create a standard poll
//     // You can customize question/options
//     const nextMon = nextMondayDate(new Date());
//     const question = `Who is playing on ${formatMDYY(nextMon)}?`;
//     const options = ["✅ Playing", "❌ Not playing"];

//     const resp = await telegram("sendPoll", {
//       chat_id: chatId.toString(),
//       question,
//       options,
//       is_anonymous: false,
//       allows_multiple_answers: false,
//     });

//     const nextMon = nextMondayDate(new Date());

//     // ✅ store the same date the poll question shows
//     const pollDate = toDateOnlyUTC(nextMon);

//     // Store poll in DB
//     const poll = resp.poll;
//     await prisma.telegramPoll.upsert({
//       where: { pollId: poll.id },
//       update: {
//         chatId,
//         messageId: BigInt(resp.message_id),
//         question: poll.question,
//         optionsJson: JSON.stringify(poll.options),
//         isClosed: Boolean(poll.is_closed),

//         pollDate,

//       },
//       create: {
//         pollId: poll.id,
//         chatId,
//         messageId: BigInt(resp.message_id),
//         question: poll.question,
//         optionsJson: JSON.stringify(poll.options),
//         isClosed: Boolean(poll.is_closed),

//         pollDate,

//       },
//     });

//     return;
//   }

  if (cmd === "/link") {
    // /link 1234  (1234 is a short code you show in Admin next to player)
    // We'll implement linking by "player id" instead (simpler + safer):
    // /link <playerId>
    const playerId = args[0];
    if (!playerId) {
      await telegram("sendMessage", {
        chat_id: chatId.toString(),
        text: "Usage: /link <playerId>\nAsk admin for your Player ID from the website.",
      });
      return;
    }

    const telegramUserId = BigInt(from.id);
    const username = from.username ? String(from.username) : null;

    try {
      const updated = await prisma.player.update({
        where: { id: playerId },
        data: {
          telegramUserId,
          telegramUsername: username ?? undefined,
        },
      });

      await telegram("sendMessage", {
        chat_id: chatId.toString(),
        text: `✅ Linked Telegram user to player: ${updated.firstName} ${updated.lastName}`,
      });
    } catch {
      await telegram("sendMessage", {
        chat_id: chatId.toString(),
        text: "❌ Could not link. Check the playerId and try again.",
      });
    }
  }

}

async function handlePollAnswer(pollAnswer: any) {
  const pollId: string = pollAnswer.poll_id;
  const user = pollAnswer.user || {};
  const userId = BigInt(user.id);
  const optionIds: number[] = Array.isArray(pollAnswer.option_ids) ? pollAnswer.option_ids : [];

  await prisma.telegramPollAnswer.upsert({
    where: { pollId_userId: { pollId, userId } },
    update: {
      username: user.username ? String(user.username) : undefined,
      firstName: user.first_name ? String(user.first_name) : undefined,
      lastName: user.last_name ? String(user.last_name) : undefined,
      optionIdsJson: JSON.stringify(optionIds),
    },
    create: {
      pollId,
      userId,
      username: user.username ? String(user.username) : undefined,
      firstName: user.first_name ? String(user.first_name) : undefined,
      lastName: user.last_name ? String(user.last_name) : undefined,
      optionIdsJson: JSON.stringify(optionIds),
    },
  });
}

async function handlePoll(poll: any) {
  // Optional: track closed/open status
  await prisma.telegramPoll.updateMany({
    where: { pollId: poll.id },
    data: { isClosed: Boolean(poll.is_closed) },
  });
}

async function telegram(method: string, body: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}
