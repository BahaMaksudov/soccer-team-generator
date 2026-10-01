import { NextResponse } from "next/server";
import { signupSchema } from "@/lib/accounts";
import { registerAccount } from "@/lib/signup";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M5 — self-service sign-up (public). Creates an UNVERIFIED User and
 * emails a verification link; it grants no Organization access. With
 * `inviteToken`, the account uses the invitation's email and the
 * invitation stays pending until the verified User accepts it
 * (src/lib/signup.ts).
 */
const INVITATION_MESSAGES = {
  INVITATION_INVALID: "This invitation link is not valid.",
  INVITATION_EXPIRED: "This invitation has expired. Ask for a new one.",
  INVITATION_USED: "This invitation has already been used.",
} as const;

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const { allowed } = await checkLoginRateLimit(`signup:${ip}`);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  try {
    const result = await registerAccount({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      inviteToken: parsed.data.inviteToken,
      next: parsed.data.next,
    });
    if (!result.ok) {
      if (result.code === "EMAIL_TAKEN") {
        return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
      }
      return NextResponse.json({ error: INVITATION_MESSAGES[result.code] }, { status: 400 });
    }
    return NextResponse.json(
      { ok: true, email: result.user.email, verificationEmailSent: result.verificationEmailSent, next: result.next },
      { status: 201 }
    );
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
