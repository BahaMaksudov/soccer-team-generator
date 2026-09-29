import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { revalidatePath } from "next/cache";
import { publishTeamsSchema, zodErrorResponse } from "@/lib/validation";
import type { TenantContext } from "@/lib/tenantContext";

/**
 * Phase 2D.6D.3 — shared Publish core, originally extracted from the
 * legacy /api/admin/publish route.
 *
 * Phase 2D.6D.5E.5 — the legacy flat route is deleted and this core is
 * now permanently DB-only: it saves the TeamGeneration for
 * (activeGroup, date) and nothing else. The old embedded Telegram
 * poll-close/teams-post branch, its private Telegram helper, and the
 * PublishOptions/allowTelegramPollActions switch are removed.
 * Generated teams reach Telegram ONLY through the separate canonical
 * Close Poll & Post Teams operation (src/lib/telegramCloseAndPost.ts),
 * which carries the durable teamsPostStatus idempotency state.
 *
 * Tenant identity is always the caller-resolved context.activeGroup —
 * never request-body groupId/organizationId.
 */
export async function publishTeamsForContext(context: TenantContext, req: Request): Promise<NextResponse> {
  const activeGroupId = context.activeGroup.id;

  const body = await req.json().catch(() => ({}));

  const parsed = publishTeamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { date: dateStr, teams, pollId } = parsed.data;

  // Reject BEFORE any TeamGeneration write: Publish never performs
  // Telegram poll actions, and silently ignoring a caller that asks for
  // them (e.g. a stale pre-5E client) would hide that its intent was not
  // carried out. pollId is empty-string by default (publishTeamsSchema),
  // so a request that never mentions Telegram is unaffected.
  if (pollId) {
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

  // Legacy public surface (`/` now redirects to the default public
  // Group's canonical page), kept fresh regardless.
  revalidatePath("/");

  // Canonical public surfaces for this specific Group. Paths derive from
  // context.organization.slug/context.activeGroup.slug (never request
  // input), so this only ever revalidates the caller's own Group's pages.
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}`);
  revalidatePath(`/g/${context.organization.slug}/${context.activeGroup.slug}/print/${saved.id}`);

  return NextResponse.json({ ok: true, id: saved.id });
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
