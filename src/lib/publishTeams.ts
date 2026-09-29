import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";
import { formatTeamsHtml, resolvePollDisplayDate } from "@/lib/telegramFormat";
import { publishTeamsSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.3 — shared Publish core, extracted verbatim from the
 * legacy /api/admin/publish route body (only the tenant resolution
 * step was removed — every remaining line, INCLUDING the embedded
 * Telegram poll-close/post branch, is unchanged). Both the legacy
 * flat route (requireTenantContext()) and the new canonical URL-bound
 * route (requireTenantContextForSlugs()) delegate here after
 * independently resolving and authorizing their own TenantContext.
 *
 * The Telegram branch is deliberately NOT split out or removed: doing
 * so would itself be "modifying Telegram behavior," which this phase
 * is explicitly not allowed to do. It remains fully intact and
 * fully shared — it simply never activates from the canonical UI,
 * which (this phase) has no Telegram affordance and therefore never
 * sends a `pollId`, so the existing `if (pollId && ...)` gate never
 * opens for a canonical-originated request. This avoids maintaining
 * two diverging Publish implementations, which would be strictly
 * riskier than sharing one unmodified implementation.
 */

/** --- Telegram helper (unchanged) --- */
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

/**
 * Server-controlled capability flag, never a request-body input —
 * passed explicitly by each route, not derived from anything the
 * client sends. The legacy route passes `true` (unchanged behavior,
 * /admin/legacy-workspace depends on it); the canonical route passes
 * `false`, so a client-supplied pollId can never activate Telegram
 * behavior there, independent of what the canonical UI happens to
 * send (Phase 2D.6D.3 follow-up — the canonical Telegram migration
 * comes in a later phase, not this one).
 */
export type PublishOptions = {
  allowTelegramPollActions: boolean;
};

export async function publishTeamsForContext(
  context: TenantContext,
  req: Request,
  options: PublishOptions
): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = publishTeamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { date: dateStr, teams, pollId } = parsed.data;
  const closePoll = parsed.data.closePoll !== false; // default true
  const postToTelegram = parsed.data.postToTelegram !== false; // default true

  // Reject BEFORE any TeamGeneration write or Telegram side effect —
  // makes the unsupported canonical contract explicit rather than
  // silently ignoring caller intent. pollId is empty-string by
  // default (publishTeamsSchema), so a request that never mentions
  // Telegram at all is completely unaffected by this check.
  if (pollId && !options.allowTelegramPollActions) {
    return NextResponse.json(
      { error: "Telegram poll actions are not supported on this endpoint." },
      { status: 400 }
    );
  }

  const normalizedDate = toDateOnlyUTC(dateStr);

  // ---------------------------------------------------------------
  // Phase 2D.2b: TeamGeneration is uniquely constrained on
  // (groupId, date). The compound selector's `groupId` is always
  // context.activeGroup.id, never client input, in both the selector
  // and the create payload, so this can only ever address (and only
  // ever create) a row owned by the caller's own Group. A different
  // Group publishing on the same date is a fully independent row.
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

  // Legacy public surface, always kept fresh regardless of which
  // route published.
  revalidatePath("/");

  // Phase 2D.6D.3: also keep the canonical public surfaces for this
  // specific Group fresh — these paths didn't exist before this
  // migration, so this is new revalidation this phase is responsible
  // for adding, not a change to legacy behavior. Deriving the path
  // from context.organization.slug/context.activeGroup.slug (never
  // from request input) means this can only ever revalidate the
  // caller's own Group's public pages.
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}`);
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}/print/${saved.id}`);

  // --- Telegram work (best-effort; should not break publishing) ---
  // Tenant-scoped as of Phase 2D.3: the poll lookup below is checked
  // against activeGroupId before any Telegram API call is made.
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

    // Ownership check BEFORE any Telegram side effect: a pollId
    // belonging to another Group must be treated exactly like a
    // pollId that doesn't exist — same status, same response shape —
    // so a caller can never distinguish "not found" from "not yours"
    // and no close/post ever reaches a foreign tenant's chat.
    if (!poll || poll.groupId !== activeGroupId) {
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

export async function deletePublishedTeamsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
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
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}`);

  return NextResponse.json({ ok: true, deleted: result.count, date: dateStr });
}
