import { createHmac, timingSafeEqual } from "node:crypto";
import { TOKEN_PATTERN } from "@/lib/secureToken";

/**
 * M9.3 — the Match Link capability token (server-only).
 *
 *   token = base64url(HMAC-SHA256(MATCH_SHARE_SECRET, "tbp:match-link:v1" ‖ matchId ‖ shareVersion))
 *
 * - 256-bit output (43 base64url chars — the same shape as every other
 *   Team Balance Pro link token); deterministic, so the organizer can copy the
 *   CURRENT link any number of times; nothing secret is stored (the database
 *   holds only Match.shareVersion).
 * - Reset Link increments Match.shareVersion → the previous token no longer
 *   verifies, immediately.
 * - Dedicated secret (security-domain separation): never NEXTAUTH_SECRET, no
 *   fallback. Without a strong MATCH_SHARE_SECRET (≥ 32 chars) nothing is
 *   issued or accepted — callers fail safely.
 * - Verification recomputes the expected token and compares in constant time.
 * - The secret and tokens are never logged.
 *
 * Player references on a Match Link are opaque, token-bound HMACs of the
 * Player id under the same secret and version (no raw Player id leaves the
 * server); they stop resolving after a reset.
 */

const LABEL_TOKEN = "tbp:match-link:v1";
const LABEL_PLAYER = "tbp:match-link-player:v1";
const MIN_SECRET_LENGTH = 32;
const PLAYER_REF_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type Env = Record<string, string | undefined>;

function secretOf(env: Env): string | null {
  const s = env.MATCH_SHARE_SECRET?.trim();
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function matchShareConfigured(env: Env = process.env): boolean {
  return secretOf(env) !== null;
}

/** Organizer-facing message when the server has no (strong) MATCH_SHARE_SECRET. */
export const MATCH_LINK_NOT_CONFIGURED = "Match links aren't set up on this server yet. Please contact Team Balance Pro support.";

function mac(secret: string, label: string, parts: Array<string | number>): Buffer {
  const h = createHmac("sha256", secret);
  h.update(label);
  for (const p of parts) {
    const v = String(p);
    h.update("\u0000");
    h.update(String(v.length));
    h.update(":");
    h.update(v);
  }
  return h.digest();
}

/** The current Match Link token, or null when match links are not configured. */
export function matchShareToken(matchId: string, shareVersion: number, env: Env = process.env): string | null {
  const secret = secretOf(env);
  if (!secret) return null;
  return mac(secret, LABEL_TOKEN, [matchId, shareVersion]).toString("base64url");
}

/** Constant-time check of a presented token against (matchId, shareVersion). False when not configured or malformed. */
export function verifyMatchShareToken(matchId: string, shareVersion: number, presented: unknown, env: Env = process.env): boolean {
  const secret = secretOf(env);
  if (!secret || typeof presented !== "string" || !TOKEN_PATTERN.test(presented)) return false;
  const expected = mac(secret, LABEL_TOKEN, [matchId, shareVersion]);
  const given = Buffer.from(presented, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Opaque, link-bound reference for a Player on this Match Link (128-bit). */
export function matchPlayerRef(matchId: string, shareVersion: number, playerId: string, env: Env = process.env): string | null {
  const secret = secretOf(env);
  if (!secret) return null;
  return mac(secret, LABEL_PLAYER, [matchId, shareVersion, playerId]).subarray(0, 16).toString("base64url");
}

export function isWellFormedPlayerRef(ref: unknown): ref is string {
  return typeof ref === "string" && PLAYER_REF_PATTERN.test(ref);
}

/** Resolve a presented player reference among candidate Player ids (constant-time per comparison). */
export function resolvePlayerRef(matchId: string, shareVersion: number, ref: unknown, playerIds: string[], env: Env = process.env): string | null {
  if (!isWellFormedPlayerRef(ref)) return null;
  const given = Buffer.from(ref, "base64url");
  let found: string | null = null;
  for (const id of playerIds) {
    const expected = Buffer.from(matchPlayerRef(matchId, shareVersion, id, env) ?? "", "base64url");
    if (expected.length === given.length && timingSafeEqual(expected, given)) found = id;
  }
  return found;
}

/** The player-facing Match Link path (token in the URL fragment — never sent to the server or in Referer). */
export function matchLinkPath(matchId: string, token: string): string {
  return `/share/m/${encodeURIComponent(matchId)}#${token}`;
}
