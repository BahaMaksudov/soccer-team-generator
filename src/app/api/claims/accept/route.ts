import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/tenantContext";
import { acceptPlayerClaim } from "@/lib/playerClaims";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M6-C — explicit claim acceptance (POST only). The User comes from the
 * session and must have a verified email (requireSessionUser → 401/403);
 * the Player/Group come only from the claim token.
 */
const MESSAGES = {
  CLAIM_INVALID: [400, "This claim link is not valid."],
  CLAIM_EXPIRED: [410, "This claim link has expired. Ask the organizer for a new one."],
  CLAIM_USED: [410, "This claim link has already been used."],
  PLAYER_ALREADY_CLAIMED: [409, "This player is already linked to another account."],
  ALREADY_HAS_PLAYER_IN_GROUP: [409, "Your account is already linked to a different player in this group."],
} as const;

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const user = await requireSessionUser();
    const { allowed } = await checkLoginRateLimit(`claim-accept:${user.id}`);
    if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
    const result = await acceptPlayerClaim(user.id, body?.token);
    if (!result.ok) {
      const [status, error] = MESSAGES[result.code];
      return NextResponse.json({ error, code: result.code }, { status });
    }
    return NextResponse.json({ ok: true, alreadyClaimed: result.alreadyClaimed, href: "/me" });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
