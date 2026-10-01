import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/tenantContext";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { acceptInvitation } from "@/lib/invitations";
import { checkLoginRateLimit } from "@/lib/rateLimit";

/**
 * M5 — accept an invitation as the signed-in User (explicit POST; the
 * /invite/[token] page only reads). The Organization and role come from
 * the invitation row; the User comes from the session and must have a
 * verified email (requireSessionUser → 403 EMAIL_NOT_VERIFIED otherwise).
 */
const bodySchema = z.object({ token: z.string().min(1).max(200) });

const MESSAGES = {
  INVITATION_INVALID: [400, "This invitation link is not valid."],
  INVITATION_EXPIRED: [410, "This invitation has expired. Ask for a new one."],
  INVITATION_USED: [410, "This invitation has already been used."],
  EMAIL_MISMATCH: [403, "This invitation was sent to a different email address. Sign in with that account to accept it."],
  EMAIL_NOT_VERIFIED: [403, "Verify your email address before accepting this invitation."],
} as const;

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const user = await requireSessionUser();
    const { allowed } = await checkLoginRateLimit(`invite-accept:${user.id}`);
    if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

    const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json({ error: MESSAGES.INVITATION_INVALID[1] }, { status: 400 });

    const result = await acceptInvitation({ userId: user.id, token: parsed.data.token });
    if (!result.ok) {
      const [status, error] = MESSAGES[result.code];
      return NextResponse.json({ error }, { status });
    }
    return NextResponse.json({ ok: true, href: "/admin" });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
