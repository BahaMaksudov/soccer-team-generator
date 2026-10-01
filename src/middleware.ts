import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { authGateDecision } from "@/lib/authGate";

// M5 — session gate for protected pages/APIs; see src/lib/authGate.ts.
export async function middleware(req: NextRequest) {
  const token = await getToken({ req });
  const decision = authGateDecision(req.nextUrl.pathname, req.nextUrl.search, !!token?.email);

  if (decision.kind === "next") return NextResponse.next();
  if (decision.kind === "unauthorized") {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.redirect(new URL(decision.loginPath, req.url));
}

// Must be a static literal for Next.js; kept identical to PROTECTED_MATCHER (asserted in tests).
export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*", "/onboarding/:path*", "/api/invitations/:path*", "/api/account/:path*", "/account/:path*"],
};
