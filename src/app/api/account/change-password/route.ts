import { NextResponse } from "next/server";
import { requireSessionAccount } from "@/lib/tenantContext";
import { changePassword, changePasswordSchema } from "@/lib/changePassword";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { zodErrorResponse } from "@/lib/validation";

/**
 * M5.1 — change the SIGNED-IN User's password. The User comes only from
 * the session (requireSessionAccount: any authenticated account, with or
 * without an Organization); the body may carry only currentPassword /
 * newPassword / confirmPassword. Responses never contain a password,
 * hash, User id or anything about how the current password was checked.
 * The client signs out afterwards and the User logs in again.
 */
export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const account = await requireSessionAccount();
    const { allowed } = await checkLoginRateLimit(`change-password:${account.id}`);
    if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

    const parsed = changePasswordSchema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

    const result = await changePassword(account.id, parsed.data);
    if (!result.ok) {
      if (result.code === "CURRENT_PASSWORD_INCORRECT") {
        return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
      }
      if (result.code === "NEW_PASSWORD_SAME") {
        return NextResponse.json({ error: "Choose a password different from your current one." }, { status: 400 });
      }
      return NextResponse.json({ error: "Your password was changed elsewhere. Please sign in again." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
