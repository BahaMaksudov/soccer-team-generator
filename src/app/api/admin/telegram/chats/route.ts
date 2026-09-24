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

  const chats = await prisma.telegramChat.findMany({
    where: { groupId: context.activeGroup.id },
    orderBy: { updatedAt: "desc" },
    select: { chatId: true, title: true },
  });

  return NextResponse.json({
    chats: chats.map((c) => ({
      chatId: c.chatId.toString(),
      title: c.title ?? "",
    })),
  });
}
