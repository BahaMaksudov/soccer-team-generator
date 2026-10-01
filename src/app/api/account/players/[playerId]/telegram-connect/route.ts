import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/tenantContext";
import { createTelegramConnectCode } from "@/lib/telegramConnect";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M6-C — a signed-in, verified User creates a short-lived /connect code for
 * a Player THEY have claimed (anyone else's Player → 404). The code is
 * returned once and stored only as a hash.
 */
type Params = Promise<{ playerId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const user = await requireSessionUser();
    const { allowed } = await checkLoginRateLimit(`telegram-connect:${user.id}`);
    if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const { playerId } = await params;
    const result = await createTelegramConnectCode(user.id, playerId);
    if (!result.ok) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    return NextResponse.json(
      { ok: true, command: result.command, deepLink: result.deepLink, expiresAt: result.expiresAt },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
