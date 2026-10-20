import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { isSameOrigin } from "@/lib/sameOrigin";
import { cancelJoinRequest } from "@/lib/groupJoin";

/** M13A — the signed-in applicant cancels their OWN pending join request (anyone else's → 404). */
const schema = z.object({ requestId: z.string().min(1).max(64) });

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const user = await requireSessionUser();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    return (await cancelJoinRequest(user.id, parsed.data.requestId))
      ? NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
      : NextResponse.json({ error: "No pending request found." }, { status: 404 });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
