import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { authGateDecision } from "@/lib/authGate";
import { CHROME_HEADER, REDESIGN_CHROME, isAppShellPath, isPublicRedesignedPath } from "@/lib/chrome";

// M5 — session gate for protected pages/APIs; see src/lib/authGate.ts.
export async function middleware(req: NextRequest) {
  // UI-1/UI-2 — the public marketing homepage and auth screens are never
  // auth-gated; only tag the request so RootLayout skips the old chrome
  // (see src/lib/chrome.ts).
  if (isPublicRedesignedPath(req.nextUrl.pathname)) return taggedNext(req);

  const token = await getToken({ req });
  const decision = authGateDecision(req.nextUrl.pathname, req.nextUrl.search, !!token?.email);

  // UI-3 — app-shell pages pass the SAME gate first; only then are they tagged.
  if (decision.kind === "next") return isAppShellPath(req.nextUrl.pathname) ? taggedNext(req) : NextResponse.next();
  if (decision.kind === "unauthorized") {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.redirect(new URL(decision.loginPath, req.url));
}

function taggedNext(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set(CHROME_HEADER, REDESIGN_CHROME);
  return NextResponse.next({ request: { headers } });
}

// Must be a static literal for Next.js; kept identical to the redesigned
// (never gated) paths of src/lib/chrome.ts plus PROTECTED_MATCHER — asserted in tests.
export const config = {
  matcher: ["/", "/login", "/signup", "/verify-email/:path*", "/admin/:path*", "/api/admin/:path*", "/onboarding/:path*", "/api/invitations/:path*", "/api/account/:path*", "/account/:path*", "/me/:path*", "/api/claims/accept"],
};
