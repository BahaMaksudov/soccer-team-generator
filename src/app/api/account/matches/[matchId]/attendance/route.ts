import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { attendanceSelfSchema, zodErrorResponse } from "@/lib/validation";
import { ATTENDANCE_CLOSED_MESSAGE, setOwnAttendance, TELEGRAM_MATCH_MESSAGE } from "@/lib/matches";

/**
 * M9-A — a signed-in, verified User sets attendance for THEIR OWN claimed
 * Player in the Match's Group (source WEB). Anyone else's Player, or a Match
 * of a Group where they claimed nobody → 404. M13A — a Telegram match is
 * answered in the poll only → 409 TELEGRAM_MATCH (also for a stale page).
 */
type Params = Promise<{ matchId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const user = await requireSessionUser();
    const parsed = attendanceSelfSchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
    const { matchId } = await params;
    const result = await setOwnAttendance(user.id, matchId, parsed.data.status);
    if (result === "not_found") return NextResponse.json({ error: "Match not found" }, { status: 404 });
    if (result === "telegram") return NextResponse.json({ error: TELEGRAM_MATCH_MESSAGE, code: "TELEGRAM_MATCH" }, { status: 409 });
    if (result === "closed") return NextResponse.json({ error: ATTENDANCE_CLOSED_MESSAGE, code: "ATTENDANCE_CLOSED" }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
