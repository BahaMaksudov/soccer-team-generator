import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireTenantContext } from "@/lib/tenantContext";
import { tenantErrorResponse } from "@/lib/tenantRoute";

export async function GET() {
  let context;
  try {
    context = await requireTenantContext();
  } catch (e) {
    return tenantErrorResponse(e);
  }
  const activeGroupId = context.activeGroup.id;

  // distinct Telegram users who voted in any poll belonging to the
  // caller's active Group — previously unscoped, which leaked every
  // tenant's voters to every other tenant's admin.
  const users = await prisma.telegramPollAnswer.findMany({
    where: { groupId: activeGroupId },
    distinct: ["userId"],
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  // already-linked telegram users, scoped the same way
  const linked = await prisma.telegramUserLink.findMany({
    where: { groupId: activeGroupId },
    select: { userId: true },
  });

  const linkedSet = new Set(linked.map((l) => l.userId.toString()));

  // ✅ BigInt -> string so JSON works
  const unlinked = users
    .filter((u) => !linkedSet.has(u.userId.toString()))
    .map((u) => ({
      userId: u.userId.toString(),
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
    }));

  return NextResponse.json(unlinked);
}
