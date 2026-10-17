/**
 * UI-2 — user-facing text for /login?error=<code> (NextAuth OAuth errors and
 * refused Google sign-ins, see src/lib/googleAuth.ts). Only known codes map
 * to specific text; the raw query value is never echoed.
 */
const MESSAGES: Record<string, string> = {
  GoogleEmailUnverified: "Google hasn't verified the email address on that account. Use a Google account with a verified email, or sign in with your password.",
  AccountEmailUnverified:
    "An account with this email already exists but its email address isn't verified yet. Sign in with your password and verify your email, then you can connect Google.",
  CredentialsSignin: "Invalid email or password.",
  // M12-A — database-backed sign-in limit (same text whether or not the account exists; no thresholds).
  LoginRateLimited: "Too many sign-in attempts. Please wait a few minutes and try again, or reset your password.",
  LoginUnavailable: "Sign-in is temporarily unavailable. Please try again in a few minutes.",
  // M12-A — explicit account linking (an email match alone never links accounts).
  GoogleLinkRequired:
    "An account with this email already exists. Sign in with your password, then connect Google under Account → Sign-in methods.",
  GoogleEmailMismatch: "That Google account uses a different email address than your Team Balance Pro account, so it wasn't connected.",
  GoogleAlreadyLinked: "That Google account is already connected to another Team Balance Pro account, or a different Google account is already connected to this one.",
  GoogleLinkExpired: "The Google connection request expired. Start again from Account → Sign-in methods.",
  GoogleAccountMissing: "Google didn't return an account identifier. Please try again.",
  // NextAuth OAuth outcomes (cancelled consent, provider errors).
  OAuthCallback: "Google sign-in was cancelled or didn't complete. Please try again.",
  OAuthSignin: "Couldn't start Google sign-in. Please try again.",
  AccessDenied: "Sign-in wasn't allowed. Please try again or use your password.",
};

const GENERIC = "Sign-in didn't complete. Please try again.";

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}
