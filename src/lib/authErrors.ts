/**
 * UI-2 — user-facing text for /login?error=<code> (NextAuth OAuth errors and
 * refused Google sign-ins, see src/lib/googleAuth.ts). Only known codes map
 * to specific text; the raw query value is never echoed.
 */
const MESSAGES: Record<string, string> = {
  GoogleEmailUnverified: "Google hasn't verified the email address on that account. Use a Google account with a verified email, or sign in with your password.",
  AccountEmailUnverified:
    "An account with this email already exists but its email address isn't verified yet. Sign in with your password and verify your email, then you can use Google.",
  CredentialsSignin: "Invalid email or password.",
};

const GENERIC = "Sign-in didn't complete. Please try again.";

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}
