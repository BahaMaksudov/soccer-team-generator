import { NextResponse } from "next/server";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { requireJsonRequest } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";
import { resetPassword, resetPasswordSchema, type ResetFailure } from "@/lib/passwordReset";

/** M11.3 — set a new password with an emailed reset token (public; explicit POST only). */
const MESSAGES: Record<ResetFailure, string> = {
  RESET_INVALID: "This reset link is not valid. Request a new one.",
  RESET_EXPIRED: "This reset link has expired. Request a new one.",
  RESET_USED: "This reset link has already been used. Request a new one if you still need it.",
};

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  if (!(await checkRateLimit("password-reset-submit", clientKey(req))).allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }
  const parsed = resetPasswordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const r = await resetPassword(parsed.data.token, parsed.data.newPassword);
  if (!r.ok) return NextResponse.json({ error: MESSAGES[r.code], code: r.code }, { status: 400 });
  return NextResponse.json({ ok: true });
}
