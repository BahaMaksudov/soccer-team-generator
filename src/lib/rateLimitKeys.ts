import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * M12-A — shared keys for the database-backed rate limits (password reset,
 * credentials login). Nothing identifying is ever stored: only keyed
 * HMAC-SHA256 digests of the normalized email and of the client address.
 *
 * Key: RATE_LIMIT_HASH_SECRET (dedicated, optional) else NEXTAUTH_SECRET (the
 * existing server-only secret). Rotating the key simply starts fresh windows.
 */
type Env = Record<string, string | undefined>;

export function rateLimitDigest(kind: string, value: string, env: Env = process.env): string {
  const key = env.RATE_LIMIT_HASH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim() || "tbp-rate-limit-local-only";
  return createHmac("sha256", key).update(`${kind}:${value}`, "utf8").digest("hex");
}

/**
 * Normalized client address for rate-limit keys:
 *   - IPv4 as is; "::ffff:1.2.3.4" (IPv4-mapped) → "1.2.3.4"; ports stripped;
 *   - IPv6 grouped by its /64 prefix (one subscriber usually holds a whole /64,
 *     so per-address keys would be trivially rotated);
 *   - anything that isn't an IP → null.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  let v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  const bracketed = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) v = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  v = v.replace(/%.*$/, ""); // zone id
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) v = mapped[1];
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind !== 6) return null;
  // Expand "::" and keep the first four hextets.
  const [head, tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = v.includes("::") ? (tail ? tail.split(":") : []) : [];
  const full = v.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (full.length !== 8 || full.some((x) => x.includes("."))) return v; // embedded IPv4 forms: keep as is
  return `${full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(":")}::/64`;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined> | null | undefined;
const header = (h: HeaderSource, name: string): string | null => {
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};

/**
 * The client address a rate limit may rely on. Forwarding headers are only
 * trusted where a trusted proxy sets them: on Vercel (VERCEL=1 — Vercel
 * overwrites X-Forwarded-For with the real client and sets X-Real-IP, so a
 * client-supplied value is never passed through) or when TRUST_PROXY_HEADERS
 * is explicitly "true" behind another trusted proxy. Elsewhere every request
 * shares the key "untrusted-proxy" (local development) — a spoofed header can
 * never pick its own bucket.
 */
export function clientAddress(headers: HeaderSource, env: Env = process.env): string {
  if (env.VERCEL !== "1" && env.TRUST_PROXY_HEADERS !== "true") return "untrusted-proxy";
  const real = normalizeIp(header(headers, "x-real-ip"));
  if (real) return real;
  const first = (header(headers, "x-forwarded-for") ?? "").split(",")[0];
  return normalizeIp(first) ?? "unknown";
}
