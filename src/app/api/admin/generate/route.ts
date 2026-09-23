import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateBalancedTeams } from "@/lib/teamGen";
import { toDateOnlyUTC } from "@/lib/dateOnly";
import { generateTeamsSchema, zodErrorResponse } from "@/lib/validation";
import type { BalanceWeights } from "@/lib/scoring";

export async function POST(req: Request) {
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
  const selected = await prisma.player.findMany({
    where: { id: { in: selectedIds }, isActive: true },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      rating: true,
      stamina: true,
    },
  });
  if (selected.length === 0) {
    return NextResponse.json({ error: "No active players selected." }, { status: 400 });
  }

  // Load balancing weights from AppSetting; generateBalancedTeams safely
  // falls back to defaults for anything missing or malformed.
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
