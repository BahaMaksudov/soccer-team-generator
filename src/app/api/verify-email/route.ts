import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyEmailToken } from "@/lib/emailVerification";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M5 — consume an email-verification token (explicit POST from the
 * /verify-email/[token] page's button). Possession of the emailed token
 * is the proof; no session is required, and none is created. GET never
 * reaches this — link scanners cannot consume tokens.
 */
const bodySchema = z.object({ token: z.string().min(1).max(200) });

const MESSAGES = {
  VERIFICATION_INVALID: [400, "This verification link is not valid. Request a new one."],
  VERIFICATION_EXPIRED: [410, "This verification link has expired. Request a new one."],
  VERIFICATION_USED: [410, "This verification link has already been used."],
} as const;

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const { allowed } = await checkLoginRateLimit(`verify-email:${ip}`);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: MESSAGES.VERIFICATION_INVALID[1] }, { status: 400 });

  try {
    const result = await verifyEmailToken(parsed.data.token);
    if (!result.ok) {
      const [status, error] = MESSAGES[result.code];
      return NextResponse.json({ error, code: result.code }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
