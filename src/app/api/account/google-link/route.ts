import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionAccount } from "@/lib/tenantContext";
import { verifyPassword } from "@/lib/accounts";
import { checkPasswordWithLimit } from "@/lib/loginLimit";
import { clientAddress } from "@/lib/rateLimitKeys";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";
import { createGoogleLinkIntent, googleLinkStatus, isGoogleAuthConfigured, LINK_INTENT_COOKIE, LINK_INTENT_TTL_MS, unlinkGoogle } from "@/lib/googleAuth";
import { sessionsCutoff } from "@/lib/passwordReset";

/**
 * M12-A — connect / disconnect Google for the SIGNED-IN User (explicit linking).
 *
 * Both require the session User AND the current password (ownership of the Team
 * Balance Pro account); the Google side is proven by completing Google OAuth.
 *   POST   → creates a single-use 10-minute link intent and sets it as an httpOnly
 *            cookie scoped to /api/auth; the browser then starts signIn("google").
 *            The callback connects that Google account to THIS User only when its
 *            verified email equals the account email (src/lib/googleAuth.ts).
 *   DELETE → removes the link and ends every session (like a password change);
 *            only for accounts that keep a password (never lock an account out).
 * Never returns ids, tokens or provider details. Verified email required.
 */
const bodySchema = z.object({ currentPassword: z.string().min(1, "Enter your current password.").max(1024) });

async function authorize(req: Request): Promise<{ userId: string } | NextResponse> {
  const account = await requireSessionAccount();
  if (!account.emailVerified) return NextResponse.json({ error: "Verify your email address first." }, { status: 403 });
  if (!isGoogleAuthConfigured()) return NextResponse.json({ error: "Google sign-in isn't available." }, { status: 404 });
  const { allowed } = await checkLoginRateLimit(`google-link:${account.id}`);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Enter your current password." }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id: account.id }, select: { passwordHash: true } });
  if (!user?.passwordHash) return NextResponse.json({ error: "This account signs in with Google only." }, { status: 400 });
  // M12-A — counts toward the database sign-in limit (fails closed: a database error propagates → 500).
  const hash = user.passwordHash;
  const checked = await checkPasswordWithLimit({ email: account.email, clientAddress: clientAddress(req.headers), source: "google-link" }, () => verifyPassword(parsed.data.currentPassword, hash));
  if (checked === "limited") return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  if (checked !== "ok") return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  return { userId: account.id };
}

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) return auth;
    if ((await googleLinkStatus(auth.userId)).linked) return NextResponse.json({ error: "Google is already connected to this account." }, { status: 409 });
    const { token } = await createGoogleLinkIntent(auth.userId);
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(LINK_INTENT_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: Math.floor(LINK_INTENT_TTL_MS / 1000) });
    return res;
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;
  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) return auth;
    if (!(await unlinkGoogle(auth.userId))) return NextResponse.json({ error: "Google isn't connected to this account." }, { status: 404 });
    // Sessions created through Google end too; the client signs out and the User signs in again.
    await prisma.user.update({ where: { id: auth.userId }, data: { sessionsValidAfter: sessionsCutoff(new Date()) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
