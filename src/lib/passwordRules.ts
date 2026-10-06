/**
 * Password rules shared by the server schema (src/lib/accounts.ts) and the
 * sign-up form's hint (client-safe: no bcrypt / Node imports).
 * bcrypt only uses the first 72 BYTES of its input; longer passwords
 * would be silently truncated, so they are rejected instead.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;
