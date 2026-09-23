import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Login rate limiting, backed by Upstash Redis (a real, serverless-safe
 * shared counter — Vercel functions do not share in-process memory
 * across instances or cold starts, so a plain in-memory counter would
 * provide close to no real protection while looking like it works).
 *
 * INACTIVE until UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * are set (see .env.example). Requires a free Upstash Redis database:
 * https://upstash.com — create one, copy its REST URL + token into
 * those two env vars. Until then, checkLoginRateLimit() is a no-op
 * that always allows the request and logs one warning.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let limiter: Ratelimit | null | undefined;
let warned = false;

function getLimiter(): Ratelimit | null {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    if (!warned) {
      console.warn(
        "[rateLimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — " +
          "login rate limiting is INACTIVE. See .env.example."
      );
      warned = true;
    }
    return null;
  }

  if (limiter === undefined) {
    limiter = new Ratelimit({
      redis: new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }),
      limiter: Ratelimit.slidingWindow(10, "10 m"),
      prefix: "ratelimit:login",
      analytics: false,
    });
  }

  return limiter;
}

export async function checkLoginRateLimit(
  key: string
): Promise<{ allowed: boolean; remaining?: number }> {
  const rl = getLimiter();
  if (!rl) return { allowed: true };

  try {
    const { success, remaining } = await rl.limit(key);
    return { allowed: success, remaining };
  } catch (e) {
    // If Upstash is unreachable, fail open rather than locking out the
    // one admin account over an infrastructure blip.
    console.error("[rateLimit] Upstash request failed, allowing request:", e);
    return { allowed: true };
  }
}
