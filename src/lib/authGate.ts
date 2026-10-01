/**
 * M5 — pure decision logic for src/middleware.ts (kept separate so it is
 * unit-testable without the Next.js runtime).
 *
 * Middleware only checks that a session exists; it never authorizes a
 * tenant. Organization/Group access is decided per request, server-side,
 * from OrganizationMembership (src/lib/tenantContext.ts).
 *
 *   - authenticated          → continue
 *   - unauthenticated API    → 401 JSON (never an HTML login page)
 *   - unauthenticated page   → /login?callbackUrl=<this internal path>
 */
export const PROTECTED_MATCHER = [
  "/admin/:path*",
  "/api/admin/:path*",
  "/onboarding/:path*",
  "/api/invitations/:path*",
  "/api/account/:path*",
];

export type AuthGateDecision =
  | { kind: "next" }
  | { kind: "unauthorized" }
  | { kind: "login"; loginPath: string };

export function authGateDecision(pathname: string, search: string, authenticated: boolean): AuthGateDecision {
  if (authenticated) return { kind: "next" };
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "unauthorized" };
  const params = new URLSearchParams({ callbackUrl: `${pathname}${search}` });
  return { kind: "login", loginPath: `/login?${params.toString()}` };
}
