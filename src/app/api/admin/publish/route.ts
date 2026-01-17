// import { prisma } from "@/lib/prisma";
// import { NextResponse } from "next/server";
// import { toDateOnlyUTC } from "@/lib/dateOnly";
// import { revalidatePath } from "next/cache";

// async function telegram(method: string, body: any) {
//   const token = process.env.TELEGRAM_BOT_TOKEN;
//   if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

//   const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify(body),
//   });

//   const data = await res.json().catch(() => null);

//   // ✅ Make stopPoll idempotent (safe to call multiple times)
//   if (!data?.ok) {
//     const msg = String(data?.description || "Telegram API error");
//     if (method === "stopPoll" && msg.toLowerCase().includes("poll has already been closed")) {
//       return null; // treat as success
//     }
//     throw new Error(msg);
//   }

//   return data.result;
// }


// function escapeHtml(s: string) {
//   return String(s)
//     .replaceAll("&", "&amp;")
//     .replaceAll("<", "&lt;")
//     .replaceAll(">", "&gt;");
// }

// function formatTeamsHtml(dateStr: string, teams: any[]) {
//   // teams shape in your app: [{ teamNumber, players: [{firstName,lastName,position,...}] }]
//   const title = <b>Generated Teams — ${escapeHtml(dateStr)}</b>\n;

//   const lines: string[] = [title];

//   for (const t of teams) {
//     lines.push(`\n<b>Team #${escapeHtml(String(t.teamNumber))}</b>`);
//     for (const p of (t.players ?? [])) {
//       const name = ${p.firstName ?? ""} ${p.lastName ?? ""}.trim();
//       lines.push(`• ${escapeHtml(name || "Unknown")}`);
//     }
//   }

//   return lines.join("\n");
// }

// // Telegram max message length is 4096 chars.
// // This splits on line boundaries so you don’t get cut off.
// function splitTelegramText(text: string, max = 3900) {
//   if (text.length <= max) return [text];
//   const out: string[] = [];
//   const lines = text.split("\n");
//   let buf = "";
//   for (const line of lines) {
//     if ((buf + "\n" + line).length > max) {
//       if (buf) out.push(buf);
//       buf = line;
//     } else {
//       buf = buf ? buf + "\n" + line : line;
//     }
//   }
//   if (buf) out.push(buf);
//   return out;
// }


// export async function POST(req: Request) {
//   const body = await req.json().catch(() => ({}));

//   const dateStr = String(body.date ?? "");
//   const teams = body.teams;

//   // optional poll close after publish
//   const pollId = body.pollId ? String(body.pollId).trim() : "";
//   const closePoll = body.closePoll !== false; // default true

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

//   // ✅ Close telegram poll if requested
//   let pollCloseStatus: "not_requested" | "not_found" | "missing_ids" | "closed_now" | "already_closed" | "failed" =
//   "not_requested";

// if (pollId && closePoll) {
//   const poll = await prisma.telegramPoll.findUnique({ where: { pollId } });

//   if (!poll) {
//     pollCloseStatus = "not_found";
//   } else if (!poll.chatId || !poll.messageId) {
//     pollCloseStatus = "missing_ids";
//   } else {
//     try {
//       await telegram("stopPoll", {
//         chat_id: poll.chatId.toString(),
//         message_id: Number(poll.messageId),
//       });

//       await prisma.telegramPoll.update({
//         where: { pollId },
//         data: { isClosed: true },
//       });

//       pollCloseStatus = "closed_now";

//       // ✅ Message 1: Poll closed
//       await telegram("sendMessage", {
//         chat_id: poll.chatId.toString(),
//         text: ✅ Poll is closed — Final Results above 👆,
//       });

//       // ✅ Message 2: Generated teams
//       const teamsHtml = formatTeamsHtml(dateStr, teams);
//       for (const chunk of splitTelegramText(teamsHtml)) {
//         await telegram("sendMessage", {
//           chat_id: poll.chatId.toString(),
//           text: chunk,
//           parse_mode: "HTML",
//           disable_web_page_preview: true,
//         });
//       }
//     } catch (e: any) {
//       // If you re-publish, Telegram may say “poll has already been closed”
//       const msg = String(e?.message ?? "");
//       if (msg.toLowerCase().includes("already been closed")) {
//         pollCloseStatus = "already_closed";
//         // Optional: still post teams even if poll already closed
//         const teamsHtml = formatTeamsHtml(dateStr, teams);
//         for (const chunk of splitTelegramText(teamsHtml)) {
//           await telegram("sendMessage", {
//             chat_id: poll.chatId.toString(),
//             text: chunk,
//             parse_mode: "HTML",
//             disable_web_page_preview: true,
//           });
//         }
//       } else {
//         pollCloseStatus = "failed";
//         // don’t throw if you still want publish to succeed
//         // (I recommend NOT failing publish because Telegram message failed)
//         console.error("Telegram close/send failed:", msg);
//       }
//     }
//   }
// }



//   // let pollCloseStatus: "not_requested" | "not_found" | "missing_message" | "already_closed" | "closed_now" = "not_requested";

//   // if (pollId && closePoll) {
//   //   const poll = await prisma.telegramPoll.findUnique({ where: { pollId } });

//   //   if (!poll) {
//   //     pollCloseStatus = "not_found";
//   //   } else if (poll.isClosed) {
//   //     pollCloseStatus = "already_closed";
//   //   } else if (poll.chatId && poll.messageId) {
//   //     // Telegram expects message_id as number
//   //     await telegram("stopPoll", {
//   //       chat_id: poll.chatId.toString(),
//   //       message_id: Number(poll.messageId),
//   //     });

//   //     // ✅ NEW: send a follow-up message in the chat
//   //     await telegram("sendMessage", {
//   //       chat_id: poll.chatId.toString(),
//   //       text: `✅ Poll is closed for ${dateStr} — Final Results above 👆`,
//   //     });

//   //     await prisma.telegramPoll.update({
//   //       where: { pollId },
//   //       data: { isClosed: true },
//   //     });

//   //     pollCloseStatus = "closed_now";
//   //   } else {
//   //     pollCloseStatus = "missing_message";
//   //     // optional: still mark closed to prevent repeated attempts
//   //     await prisma.telegramPoll.update({
//   //       where: { pollId },
//   //       data: { isClosed: true },
//   //     });
//   //   }
//   // }

  
//   revalidatePath("/");

//   // return NextResponse.json({ ok: true, id: saved.id });
//   return NextResponse.json({ ok: true, id: saved.id, pollCloseStatus });
// }

// export async function DELETE(req: Request) {
//   const url = new URL(req.url);
//   const dateStr = url.searchParams.get("date");

//   if (!dateStr) {
//     return NextResponse.json(
//       { error: "date query param is required (YYYY-MM-DD)" },
//       { status: 400 }
//     );
//   }

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

/** --- Telegram helper --- */
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

function formatMDYY(d: Date) {
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/** Telegram HTML escaping */
function escapeHtml(s: string) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parsePollDateFromQuestion(question?: string | null): string | null {
  if (!question) return null;
  // matches: "Who is playing on 1/19/26?"
  const m = question.match(/\bon\s+(\d{1,2}\/\d{1,2}\/\d{2})\b/i);
  return m?.[1] ?? null;
}

function formatDateForTelegramFromISO(dateStr: string): string {
  // dateStr expected: "YYYY-MM-DD" or ISO-ish. We'll normalize to UTC date.
  const d = new Date(dateStr);
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/** Format teams as Telegram HTML message */
function formatTeamsHtml(displayDate: string, teams: any[]) {
  const title = `<b>🏟️ Generated Teams — ${escapeHtml(displayDate)}</b>`;
  const lines: string[] = [title, ""];

  for (const t of teams) {
    lines.push(`<b>Team #${escapeHtml(String(t.teamNumber))}</b>`);
    const players = Array.isArray(t.players) ? t.players : [];
    for (const p of players) {
      const first = (p?.firstName ?? "").toString().trim();
      const last = (p?.lastName ?? "").toString().trim();
      const name = `${first} ${last}`.trim() || "Unknown";
      lines.push(`• ${escapeHtml(name)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const dateStr = String(body.date ?? "");
  const teams = body.teams;

  // optional poll close + posting
  const pollId = String(body.pollId ?? "").trim();
  const closePoll = body.closePoll !== false; // default true
  const postToTelegram = body.postToTelegram !== false; // default true

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

  revalidatePath("/");

  // --- Telegram work (best-effort; should not break publishing) ---
  let pollStatus:
    | "not_requested"
    | "poll_not_found_in_db"
    | "missing_message_or_chat"
    | "closed_now"
    | "already_closed"
    | "token_missing"
    | "close_failed" = "not_requested";

  let telegramTeamsPosted = false;

  if (pollId && (closePoll || postToTelegram)) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      pollStatus = "token_missing";
      return NextResponse.json({
        ok: true,
        id: saved.id,
        pollStatus,
        telegramTeamsPosted,
      });
    }

    const poll = await prisma.telegramPoll.findUnique({ where: { pollId } });

    // Prefer the poll question date (1/19/26). Fallback to publish date formatted.
    const displayDate =
      parsePollDateFromQuestion(poll?.question) ??
      (dateStr ? formatDateForTelegramFromISO(dateStr) : null) ??
      "unknown date";

    if (!poll) {
      pollStatus = "poll_not_found_in_db";
      return NextResponse.json({
        ok: true,
        id: saved.id,
        pollStatus,
        telegramTeamsPosted,
      });
    }

    const chatId = poll.chatId?.toString();
    const messageId = poll.messageId != null ? Number(poll.messageId) : null;

    if (!chatId || !messageId) {
      pollStatus = "missing_message_or_chat";
      return NextResponse.json({
        ok: true,
        id: saved.id,
        pollStatus,
        telegramTeamsPosted,
      });
    }

    // 1) Close poll (if requested)
    if (closePoll) {
      try {
        await telegram("stopPoll", {
          chat_id: chatId,
          message_id: messageId,
        });

        await prisma.telegramPoll.update({
          where: { pollId },
          data: { isClosed: true },
        });

        pollStatus = "closed_now";

        // Telegram poll card text cannot be changed -> post a follow-up message instead
        await telegram("sendMessage", {
          chat_id: chatId,
          // text: "✅ Poll is closed — final results above.",
          text: `✅ Poll is closed for ${displayDate}`,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (msg.toLowerCase().includes("already been closed")) {
          pollStatus = "already_closed";
          // Optional: still send info message (so people know why it says Final Results)
          await telegram("sendMessage", {
            chat_id: chatId,
            text: "✅ Poll is already closed",
          }).catch(() => {});
        } else {
          pollStatus = "close_failed";
          // continue to post teams (don’t block publish)
        }
      }
    }

    // 2) Post generated teams message (if requested)
//     if (postToTelegram) {
//       try {
//         // const html = formatTeamsHtml(dateStr, teams);
//         let headerDateStr = dateStr;

//       // ✅ prefer pollDate when pollId provided
//     if (poll?.pollDate instanceof Date) {
//         headerDateStr = formatMDYY(poll.pollDate);
//       }

// const html = formatTeamsHtml(headerDateStr, teams);
//         await telegram("sendMessage", {
//           chat_id: chatId,
//           text: html,
//           parse_mode: "HTML",
//           disable_web_page_preview: true,
//         });
//         telegramTeamsPosted = true;
//       } catch {
//         // don’t block publish
//       }
//     }

if (postToTelegram) {
  try {
    // IMPORTANT: use displayDate (already "1/19/26"), NOT dateStr / ISO
    const html = formatTeamsHtml(displayDate, teams);

    await telegram("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    telegramTeamsPosted = true;
  } catch {
    // don’t block publish
  }
}
  }

  return NextResponse.json({
    ok: true,
    id: saved.id,
    pollStatus,
    telegramTeamsPosted,
  });
}


export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const dateStr = url.searchParams.get("date"); // expected YYYY-MM-DD

  if (!dateStr) {
    return NextResponse.json(
      { error: "date query param is required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  /**
   * Interpret the date as a CALENDAR DAY, not a moment in time.
   * We build a UTC range that safely covers that whole day.
   */
  const [y, m, d] = dateStr.split("-").map(Number);

  // Start of day UTC
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  // End of day UTC (exclusive)
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));

  const result = await prisma.teamGeneration.deleteMany({
    where: {
      date: {
        gte: start,
        lt: end,
      },
    },
  });

  revalidatePath("/");

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    date: dateStr,
  });
}

// export async function DELETE(req: Request) {
//   const url = new URL(req.url);
//   const dateStr = url.searchParams.get("date");

//   if (!dateStr) {
//     return NextResponse.json(
//       { error: "date query param is required (YYYY-MM-DD)" },
//       { status: 400 }
//     );
//   }

//   const start = toDateOnlyUTC(dateStr);
//   const end = new Date(start);
//   end.setUTCDate(end.getUTCDate() + 1);

//   const result = await prisma.teamGeneration.deleteMany({
//     where: {
//       date: { gte: start, lt: end },
//     },
//   });

//   revalidatePath("/");

//   return NextResponse.json({ ok: true, deleted: result.count, start, end });
// }
