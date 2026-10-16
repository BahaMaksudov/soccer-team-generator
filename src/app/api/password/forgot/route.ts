import { after, NextResponse } from "next/server";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { normalizeEmail } from "@/lib/emailAddress";
import { deliverResetDispatch, FORGOT_PASSWORD_MESSAGE, forgotPasswordSchema, preparePasswordReset } from "@/lib/passwordReset";
import { checkPasswordResetLimit } from "@/lib/passwordResetLimit";

/**
 * M11.3 — "Forgot password" (public). Always the same 200 + generic message,
 * whether or not the email has an account (no enumeration). The lookup, token
 * and email happen AFTER the response, so its timing doesn't depend on the
 * account either.
 *
 * Rate limits, two layers:
 *   1. Upstash per client address (optional; fails open when missing / down);
 *   2. the database request log (always on; fails CLOSED — see passwordResetLimit):
 *      per client address → 429; per email / service-wide → generic answer, nothing sent.
 */
export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  const address = clientKey(req);
  const tooMany = () => NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  if (!(await checkRateLimit("password-reset-ip", address)).allowed) return tooMany();
  const parsed = forgotPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email address." }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);

  let decision;
  try {
    decision = await checkPasswordResetLimit(email, address);
  } catch (e) {
    // No limit check → no email. Fail closed.
    console.error(`[password-reset] rate limit unavailable: ${e instanceof Error ? e.name : "error"}`);
    return NextResponse.json({ error: "Password reset is temporarily unavailable. Please try again later." }, { status: 503 });
  }
  if (decision === "ip_limited") return tooMany();
  if (decision === "global_limited") console.error("[password-reset] service-wide limit reached — reset emails paused for this window");
  if (decision === "send") {
    after(async () => {
      try {
        await deliverResetDispatch(await preparePasswordReset(email));
      } catch (e) {
        console.error(`[password-reset] request failed: ${e instanceof Error ? e.name : "error"}`);
      }
    });
  }
  return NextResponse.json({ ok: true, message: FORGOT_PASSWORD_MESSAGE });
}
