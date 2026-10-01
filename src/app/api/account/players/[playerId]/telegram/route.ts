import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/tenantContext";
import { disconnectOwnTelegram } from "@/lib/telegramIdentity";
import { accountRouteErrorResponse } from "@/lib/tenantRoute";

/**
 * M6.1 — a signed-in, verified User disconnects Telegram from a Player
 * THEY currently claim (anyone else's Player → 404). Only that Player's
 * link in its own Group is removed; the claim, history and other Groups'
 * links stay. Idempotent. No Telegram API call.
 */
type Params = Promise<{ playerId: string }>;

export async function DELETE(_req: Request, { params }: { params: Params }) {
  try {
    const user = await requireSessionUser();
    const { playerId } = await params;
    const result = await disconnectOwnTelegram(user.id, playerId);
    if (result === "not_found") return NextResponse.json({ error: "Player not found" }, { status: 404 });
    return NextResponse.json({ ok: true, removed: result === "removed" });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
