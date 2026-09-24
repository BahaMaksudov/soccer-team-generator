import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";
import { formatTeamsHtml, resolvePollDisplayDate } from "@/lib/telegramFormat";
import { publishTeamsSchema, zodErrorResponse } from "@/lib/validation";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

/** --- Telegram helper --- */
async function telegram(method: string, body: unknown) {
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
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = publishTeamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { date: dateStr, teams, pollId } = parsed.data;
  const closePoll = parsed.data.closePoll !== false; // default true
  const postToTelegram = parsed.data.postToTelegram !== false; // default true

  const normalizedDate = toDateOnlyUTC(dateStr);

  // ---------------------------------------------------------------
  // Phase 2D.2b: TeamGeneration is now uniquely constrained on
  // (groupId, date) — see prisma/migrations/
  // 20260924214047_phase_2d_2b_team_generation_group_date_unique —
  // replacing the old single-column, globally-unique `date`. That
  // restores a single atomic, tenant-safe upsert: the compound
  // selector's `groupId` is always context.activeGroup.id, never
  // client input, in both the selector and the create payload, so
  // this can only ever address (and only ever create) a row owned by
  // the caller's own Group. A different Group publishing on the same
  // date is now a fully independent row — no collision, no
  // check-then-act race window, restoring the atomicity Phase 1
  // originally established.
  // ---------------------------------------------------------------
  let saved;
  try {
    saved = await prisma.teamGeneration.upsert({
      where: { groupId_date: { groupId: activeGroupId, date: normalizedDate } },
      update: { teamsJson: JSON.stringify(teams) },
      create: { date: normalizedDate, teamsJson: JSON.stringify(teams), groupId: activeGroupId },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to save published teams.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  revalidatePath("/");

  // --- Telegram work (best-effort; should not break publishing) ---
  // Deliberately NOT tenant-scoped in this phase — Telegram ownership
  // resolution (TelegramChat/TelegramPoll → Group) is explicitly
  // deferred to Phase 2D.3. Current production has exactly one Group
  // and both existing Telegram chats already belong to it (Phase 2C
  // backfill), so this is not a live cross-tenant gap today, but it
  // will need scoping before a second Group with its own Telegram
  // integration exists. See Phase 2D.2 report §O.
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
      return NextResponse.json({ ok: true, id: saved.id, pollStatus, telegramTeamsPosted });
    }

    const poll = await prisma.telegramPoll.findUnique({ where: { pollId } });

    if (!poll) {
      pollStatus = "poll_not_found_in_db";
      return NextResponse.json({ ok: true, id: saved.id, pollStatus, telegramTeamsPosted });
    }

    // Source of truth for the displayed game date: TelegramPoll.pollDate
    // first (the real column), falling back to parsing the poll's
    // free-text question only for legacy rows with no pollDate, and
    // finally to the publish date as a last resort.
    const displayDate = resolvePollDisplayDate(poll, dateStr);

    const chatId = poll.chatId?.toString();
    const messageId = poll.messageId != null ? Number(poll.messageId) : null;

    if (!chatId || !messageId) {
      pollStatus = "missing_message_or_chat";
      return NextResponse.json({ ok: true, id: saved.id, pollStatus, telegramTeamsPosted });
    }

    // 1) Close poll (if requested)
    if (closePoll) {
      try {
        await telegram("stopPoll", { chat_id: chatId, message_id: messageId });

        await prisma.telegramPoll.update({ where: { pollId }, data: { isClosed: true } });

        pollStatus = "closed_now";

        // Telegram poll card text cannot be changed -> post a follow-up message instead
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `✅ Poll is closed for ${displayDate}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("already been closed")) {
          pollStatus = "already_closed";
          await telegram("sendMessage", {
            chat_id: chatId,
            text: "✅ Poll is already closed",
          }).catch(() => {});
        } else {
          pollStatus = "close_failed";
          // continue to post teams (don't block publish)
        }
      }
    }

    // 2) Post generated teams message (if requested)
    if (postToTelegram) {
      try {
        const html = formatTeamsHtml(displayDate, teams);

        await telegram("sendMessage", {
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });

        telegramTeamsPosted = true;
      } catch {
        // don't block publish
      }
    }
  }

  return NextResponse.json({ ok: true, id: saved.id, pollStatus, telegramTeamsPosted });
}

export async function DELETE(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const url = new URL(req.url);
  const dateStr = url.searchParams.get("date"); // expected YYYY-MM-DD

  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
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

  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));

  // deleteMany is a single filter-based statement — adding groupId
  // here is fully atomic and correct: a tenant can only ever delete
  // rows that are both in this date range AND already owned by their
  // own active Group.
  const result = await prisma.teamGeneration.deleteMany({
    where: { date: { gte: start, lt: end }, groupId: context.activeGroup.id },
  });

  revalidatePath("/");

  return NextResponse.json({ ok: true, deleted: result.count, date: dateStr });
}
