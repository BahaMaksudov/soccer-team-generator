import { resendKeyConfigured } from "@/lib/email/transport";

type Env = Record<string, string | undefined>;

/** True only for a database on this machine whose name says it is a test database. */
export function isLocalTestDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return /^postgres(ql)?:$/.test(u.protocol) && ["localhost", "127.0.0.1", "::1"].includes(host) && /test/i.test(decodeURIComponent(u.pathname.slice(1)));
  } catch {
    return false;
  }
}

/**
 * M13B P8A — the live-pilot switch. Its own variable with one exact value, so no existing
 * setting (EMAIL_TRANSPORT, RESEND_API_KEY, EMAIL_FROM …) can turn RSVP delivery on.
 */
export const RSVP_LIVE_FLAG = "RSVP_EMAIL_DELIVERY";
export const RSVP_LIVE_FLAG_VALUE = "live-pilot";
export const RSVP_PILOT_ORGS = "RSVP_EMAIL_PILOT_ORGS";
/** The only domains RSVP invitations may be sent from (Resend-verified sending domain). */
export const RSVP_SENDER_DOMAINS = ["mail.teambalancepro.com"] as const;
/**
 * Pilot sending limits, applied ON TOP of the plan allowance (the lower one wins) while
 * delivery is live. In code — not environment — so they can't be raised by accident.
 */
export const RSVP_PILOT_LIMITS = { perOrganizationDay: 20, perOrganizationMonth: 100, allOrganizationsDay: 100 } as const;

const ORG_ID = /^[a-z0-9]{20,40}$/; // cuid-style organization ids

/** The pilot allowlist, or null when it is missing or malformed (fail closed: one bad entry disables it all). */
export function pilotOrganizations(env: Env = process.env): Set<string> | null {
  const raw = env[RSVP_PILOT_ORGS]?.trim();
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim());
  if (ids.length === 0 || ids.length > 10 || ids.some((id) => !ORG_ID.test(id))) return null;
  return new Set(ids);
}

/** EMAIL_FROM must be `Display Name <local@verified-domain>` on an RSVP sender domain. */
export function rsvpSenderValid(from: string | undefined): boolean {
  const m = from?.trim().match(/^([^<>\r\n@]{1,60}) <([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]{1,190})>$/);
  return Boolean(m && m[1].trim() && (RSVP_SENDER_DOMAINS as readonly string[]).includes(m[3].toLowerCase()));
}

export type RsvpDeliveryMode = "test-outbox" | "live" | "disabled";

/**
 * M13B P5/P8A — the ONLY switch for RSVP delivery, decided on the server from the process
 * environment:
 *   "test-outbox" — NODE_ENV=test (automated tests), or a CONFIRMED LOCAL TEST environment:
 *                   NODE_ENV=development AND RSVP_EMAIL_LOCAL_TEST_OUTBOX=1 AND not on
 *                   Vercel AND DATABASE_URL is a local database named *test*. In-memory only.
 *   "live"        — the Resend pilot, ONLY when ALL of these hold:
 *                   NODE_ENV=production AND VERCEL_ENV=production (never Preview / dev /
 *                   local `next start`) AND RSVP_EMAIL_DELIVERY="live-pilot" exactly AND a
 *                   valid non-empty RSVP_EMAIL_PILOT_ORGS allowlist AND a Resend key configured
 *                   AND EMAIL_FROM is a display-name sender on an RSVP sender domain.
 *   "disabled"    — everything else (the default everywhere today).
 * Even when live, only allowlisted organizations can send (rsvpDeliveryAllowedFor).
 */
export function rsvpDeliveryMode(env: Env = process.env): RsvpDeliveryMode {
  if (env.NODE_ENV === "test") return "test-outbox";
  if (env.NODE_ENV === "development") {
    return env.RSVP_EMAIL_LOCAL_TEST_OUTBOX === "1" && !env.VERCEL && !env.VERCEL_ENV && isLocalTestDatabaseUrl(env.DATABASE_URL) ? "test-outbox" : "disabled";
  }
  if (
    env.NODE_ENV === "production" &&
    env.VERCEL_ENV === "production" &&
    env[RSVP_LIVE_FLAG] === RSVP_LIVE_FLAG_VALUE &&
    pilotOrganizations(env) !== null &&
    resendKeyConfigured(env) &&
    rsvpSenderValid(env.EMAIL_FROM)
  ) {
    return "live";
  }
  return "disabled";
}

/** Whether this organization may send RSVP invitations right now (live: allowlisted only). */
export function rsvpDeliveryAllowedFor(organizationId: string, env: Env = process.env): boolean {
  const mode = rsvpDeliveryMode(env);
  if (mode === "test-outbox") return true;
  if (mode === "live") return pilotOrganizations(env)!.has(organizationId);
  return false;
}
