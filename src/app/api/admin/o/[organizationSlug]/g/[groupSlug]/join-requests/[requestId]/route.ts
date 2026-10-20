import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantContextForSlugs } from "@/lib/tenantContext";
import { canonicalTenantErrorResponse, managersOnlyResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { playerCreateSchema, zodErrorResponse } from "@/lib/validation";
import { CommunityChoiceError, communityChoiceResponse, playerRoleError } from "@/lib/playerCrud";
import { approveJoinRequest, rejectJoinRequest } from "@/lib/groupJoin";

/**
 * M13A — decide ONE join request (OWNER/ADMIN; MEMBER / foreign → generic 404).
 *   { action: "approve", playerId }   → link the applicant to that UNCLAIMED Player of this Group
 *   { action: "approve", newPlayer }  → create a Player for them (same validation and plan
 *                                       limits as "Add player") and link it
 *   { action: "reject" }              → nothing is created or linked
 * Explicit only — never automatic, never by name or email.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; requestId: string }>;
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), playerId: z.string().min(1).max(64).optional(), newPlayer: z.unknown().optional() }),
  z.object({ action: z.literal("reject") }),
]);
const FAILURES: Record<string, [number, string]> = {
  NOT_FOUND: [404, "Request not found."],
  NOT_PENDING: [409, "This request was already decided."],
  PLAYER_NOT_FOUND: [404, "That player isn't in this group."],
  PLAYER_ALREADY_CLAIMED: [409, "That player is already linked to another account."],
  ALREADY_MEMBER: [409, "This person is already linked to a player in this group."],
};

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const { requestId, ...slugs } = await params;
  try {
    const context = await requireTenantContextForSlugs(slugs);
    const denied = managersOnlyResponse(context);
    if (denied) return denied;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

    let result;
    if (parsed.data.action === "reject") {
      result = await rejectJoinRequest(context, requestId);
    } else if (parsed.data.playerId && parsed.data.newPlayer === undefined) {
      result = await approveJoinRequest(context, requestId, { playerId: parsed.data.playerId });
    } else if (!parsed.data.playerId && parsed.data.newPlayer !== undefined) {
      const player = playerCreateSchema.safeParse(parsed.data.newPlayer);
      if (!player.success) return NextResponse.json(zodErrorResponse(player.error), { status: 400 });
      const invalidRole = playerRoleError(context, player.data.position);
      if (invalidRole) return invalidRole;
      result = await approveJoinRequest(context, requestId, { newPlayer: player.data });
    } else {
      return NextResponse.json({ error: "Choose an existing player or create a new one." }, { status: 400 });
    }
    if (!result.ok) {
      const [status, error] = FAILURES[result.code];
      return NextResponse.json({ error, code: result.code }, { status });
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof CommunityChoiceError) return communityChoiceResponse(e);
    return canonicalTenantErrorResponse(e); // incl. 402 PLAN_LIMIT
  }
}
