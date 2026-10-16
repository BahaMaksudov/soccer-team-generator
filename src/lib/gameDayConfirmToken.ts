import { createHmac, timingSafeEqual } from "node:crypto";
import type { GameDayWeather } from "@/lib/messaging/gameDayUpdate";

/**
 * Manual Game Day Update — the server-signed confirmation of ONE previewed
 * message. The preview signs everything the message was built from that the
 * send must not silently change: tenant (organization, group, match), the
 * organizer who reviewed it, the destination (poll + chat), the deadline, the
 * attendance counts, the weather snapshot, the preview instant and the SHA-256
 * of the exact text. The send rebuilds the text from the CURRENT database facts
 * at the preview instant with this weather and sends it only if it is
 * byte-identical — so what is sent is exactly what the organizer approved.
 *
 * Nothing is stored. HMAC-SHA256 under NEXTAUTH_SECRET with its own domain
 * prefix (separate from every other signed value). Short-lived: a countdown
 * older than PREVIEW_TTL_MS is materially outdated and must be previewed again.
 */
export const PREVIEW_TTL_MS = 2 * 60_000;
const MAX_TOKEN_LENGTH = 8000;

export type GameDayConfirmClaims = {
  /** organization, group, match, reviewing user */
  o: string;
  g: string;
  m: string;
  u: string;
  /** poll id + Telegram chat id (string) */
  p: string;
  c: string;
  /** deadline (epoch ms) */
  d: number;
  /** attendance counts shown (Playing, Maybe, Not Playing, Not Responded) */
  pl: number;
  mb: number;
  np: number;
  nr: number;
  /** weather snapshot shown (null = none) */
  w: GameDayWeather | null;
  /** SHA-256 (hex) of the exact message text */
  h: string;
  /** preview instant + expiry (epoch ms) */
  iat: number;
  exp: number;
};

function signingKey(): string | null {
  const s = process.env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}
const sign = (payload: string, key: string) => createHmac("sha256", `game-day-confirm:${key}`).update(payload).digest("base64url");

/** null when no signing secret is configured (manual sending is then unavailable). */
export function signGameDayConfirm(claims: Omit<GameDayConfirmClaims, "exp">): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: claims.iat + PREVIEW_TTL_MS } satisfies GameDayConfirmClaims)).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export type VerifyResult = { ok: true; claims: GameDayConfirmClaims } | { ok: false; reason: "INVALID" | "EXPIRED" };

/** Valid signature, same tenant / match / user, not expired. Never throws. */
export function verifyGameDayConfirm(token: unknown, expect: { o: string; g: string; m: string; u: string }, now = Date.now()): VerifyResult {
  const key = signingKey();
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "INVALID" };
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined) return { ok: false, reason: "INVALID" };
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "INVALID" };
  let c: GameDayConfirmClaims;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GameDayConfirmClaims;
  } catch {
    return { ok: false, reason: "INVALID" };
  }
  if (!c || c.o !== expect.o || c.g !== expect.g || c.m !== expect.m || c.u !== expect.u) return { ok: false, reason: "INVALID" };
  if (![c.d, c.pl, c.mb, c.np, c.nr, c.iat, c.exp].every((n) => typeof n === "number" && Number.isFinite(n))) return { ok: false, reason: "INVALID" };
  if (typeof c.p !== "string" || typeof c.c !== "string" || typeof c.h !== "string" || !/^[0-9a-f]{64}$/.test(c.h)) return { ok: false, reason: "INVALID" };
  if (c.exp - c.iat !== PREVIEW_TTL_MS) return { ok: false, reason: "INVALID" };
  if (c.exp <= now) return { ok: false, reason: "EXPIRED" };
  return { ok: true, claims: c };
}
