import { after, NextResponse } from "next/server";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { normalizeEmail } from "@/lib/emailAddress";
import { deliverResetDispatch, FORGOT_PASSWORD_MESSAGE, forgotPasswordSchema, preparePasswordReset } from "@/lib/passwordReset";

/**
 * M11.3 — "Forgot password" (public). Always the same 200 + generic message,
 * whether or not the email has an account (no enumeration). The lookup, token
 * and email happen AFTER the response, so its timing doesn't depend on the
 * account either. Rate limits: per client address (429) and per email address
 * (silently nothing more is sent — still the generic answer).
 */
export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("password-reset-ip", clientKey(req))).allowed) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  }
  const parsed = forgotPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email address." }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);
  if ((await checkRateLimit("password-reset-email", email)).allowed) {
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
