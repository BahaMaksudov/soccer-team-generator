import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionAccount } from "@/lib/tenantContext";
import { resendVerification } from "@/lib/emailVerification";
import { checkLoginRateLimit } from "@/lib/rateLimit";
import { accountRouteErrorResponse, requireJsonRequest } from "@/lib/tenantRoute";

/**
 * M5 — send a fresh verification link to the SIGNED-IN User's own email
 * (the address is never taken from the request, so this cannot be used
 * to probe or spam other addresses). Replaces any older link. Already
 * verified → idempotent success.
 */
const bodySchema = z.object({ next: z.string().max(2048).optional() });

export async function POST(req: Request) {
  const notJson = requireJsonRequest(req);
  if (notJson) return notJson;

  try {
    const account = await requireSessionAccount();
    const { allowed } = await checkLoginRateLimit(`verify-resend:${account.id}`);
    if (!allowed) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

    const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
    const result = await resendVerification(account.id, parsed.success ? parsed.data.next : null);
    if (result.alreadyVerified) return NextResponse.json({ ok: true, alreadyVerified: true });
    if (!result.emailSent) {
      return NextResponse.json(
        { error: "We couldn't send the verification email right now. Please try again in a few minutes." },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, alreadyVerified: false });
  } catch (e) {
    return accountRouteErrorResponse(e);
  }
}
