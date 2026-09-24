import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateBalancedTeams } from "@/lib/teamGen";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { generateTeamsSchema, zodErrorResponse } from "@/lib/validation";
import type { BalanceWeights } from "@/lib/scoring";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

export async function POST(req: Request) {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }

  const body = await req.json().catch(() => ({}));

  const parsed = generateTeamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { teamCount, date: dateStr, selectedIds, format } = parsed.data;

  const normalizedDate = toDateOnlyUTC(dateStr);
  // Explicit select: fetch only what the generator needs and what the
  // Admin preview/home page/print view actually render. In particular,
  // this deliberately excludes telegramUserId (BigInt) and the other
  // Telegram-linking fields — a Player row with a linked Telegram
  // account previously made this route 500, because NextResponse.json
  // cannot serialize a native BigInt and the full Player record (as
  // fetched before this fix) was returned unmodified inside the
  // generated teams.
  //
  // groupId is scoped to the caller's own active Group — selectedIds is
  // untrusted client input, and without this filter a request could
  // include another tenant's Player ids and have them silently pulled
  // into generation.
  const selected = await prisma.player.findMany({
    where: { id: { in: selectedIds }, isActive: true, groupId: context.activeGroup.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      rating: true,
      stamina: true,
    },
  });

  // Reject rather than silently proceeding with a smaller roster: a
  // mismatch between the requested and resolved id counts means at
  // least one id was invalid, inactive, or (most importantly) belongs
  // to a different Group. Never reveal which — the error is identical
  // either way.
  if (selected.length !== selectedIds.length) {
    return NextResponse.json(
      { error: "One or more selected players are invalid or unavailable." },
      { status: 400 }
    );
  }
  if (selected.length === 0) {
    return NextResponse.json({ error: "No active players selected." }, { status: 400 });
  }

  // Load balancing weights from AppSetting; generateBalancedTeams safely
  // falls back to defaults for anything missing or malformed.
  // (AppSetting stays global/unscoped in this phase — see Phase 2D.2
  // report §O; settings migration to GroupSetting is deliberately out
  // of scope here.)
  const row = await prisma.appSetting.findUnique({ where: { key: "balanceWeights" } });
  let weights: BalanceWeights | undefined;
  if (row?.value) {
    try {
      weights = JSON.parse(row.value);
    } catch {
      weights = undefined;
    }
  }

  let teams;
  try {
    teams = generateBalancedTeams(selected, teamCount, format, weights);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to generate teams.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ date: normalizedDate.toISOString(), teams });
}
