/**
 * Google Analytics 4 — the privacy rules, as pure functions (client-safe: no Node / Prisma imports).
 *
 * GA4 runs ONLY when ALL of these hold (analyticsAllowed + the consent check in the component):
 *   - NEXT_PUBLIC_GA_MEASUREMENT_ID is a well-formed GA4 id (set in Vercel PRODUCTION only);
 *   - NEXT_PUBLIC_VERCEL_ENV === "production" (Vercel's own system variable — Preview and
 *     Development never qualify, whatever else is configured);
 *   - the page is served from the production hostname (ANALYTICS_HOSTS);
 *   - the visitor accepted analytics cookies (opt-in for everyone; nothing loads before);
 *   - the page is on the strict allowlist (ANALYTICS_ROUTES): public marketing and sign-in
 *     pages only. Player-facing pages (possibly minors who never agreed to anything), token
 *     links, and the signed-in organizer area are never tracked.
 * Every page_location / page_referrer / page_title sent to Google is rebuilt here from a
 * template — never the raw browser URL or document.title.
 */

export const ANALYTICS_HOSTS: readonly string[] = ["teambalancepro.com"];

/**
 * EXACT paths only (no prefix matching): "/pricing" is tracked, "/pricing/anything" is not.
 * Not listed — and therefore never tracked — includes:
 *   token links      /verify-email/<token>, /reset-password/<token>, /invite/<token>, /unsubscribe
 *   player pages     /attend, /share/**, /join, /claim, /g/**, /players/**, /print/**, /me/**
 *   signed-in app    /admin/** (organization / group names in URLs; Telegram deep links with
 *                    connect codes would reach GA as outbound clicks), /account/**
 *   redirect-only    /upgrade (never renders a page)
 */
export const ANALYTICS_ROUTES: Readonly<Record<string, string>> = {
  "/": "Home",
  "/pricing": "Pricing",
  "/terms": "Terms of Service",
  "/privacy": "Privacy Policy",
  "/login": "Sign in",
  "/signup": "Sign up",
  "/forgot-password": "Forgot password",
  "/verify-email": "Verify email",
  "/onboarding": "Create organization",
};

/** Campaign attribution only; values must be plain tokens (no "@", spaces or URL syntax). */
const KEPT_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const SAFE_PARAM_VALUE = /^[A-Za-z0-9._~+-]{1,100}$/;
/** The sign-up plan intent (?plan=month|year) is kept on the two pages that use it. */
const PLAN_PAGES = new Set(["/pricing", "/signup"]);

export const GA_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

export function validMeasurementId(id: string | null | undefined): string | null {
  const v = id?.trim() ?? "";
  return GA_ID_PATTERN.test(v) ? v : null;
}

/** The deployment gate (consent and route are checked separately). Fails closed. */
export function analyticsAllowed(input: { measurementId: string | null | undefined; vercelEnv: string | null | undefined; hostname: string | null | undefined }): boolean {
  return validMeasurementId(input.measurementId) !== null && input.vercelEnv === "production" && ANALYTICS_HOSTS.includes((input.hostname ?? "").toLowerCase());
}

/** "/pricing/" → "/pricing"; anything odd ("//x", no leading "/") → null. */
function normalizePath(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : "/";
}

export function isAnalyticsRoute(pathname: string | null | undefined): boolean {
  const p = normalizePath(pathname ?? "");
  return p !== null && Object.prototype.hasOwnProperty.call(ANALYTICS_ROUTES, p);
}

/**
 * The page_location sent to GA: origin + allowlisted path + approved attribution parameters.
 * No fragment, no other query parameter (tokens, emails, callbackUrl, session_id, org…).
 * Not an allowlisted page → null (nothing is sent).
 */
export function sanitizePageLocation(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = normalizePath(url.pathname);
  if (path === null || !isAnalyticsRoute(path)) return null;
  const kept = new URLSearchParams();
  for (const k of KEPT_PARAMS) {
    const v = url.searchParams.get(k);
    if (v && SAFE_PARAM_VALUE.test(v)) kept.set(k, v);
  }
  const plan = url.searchParams.get("plan");
  if (PLAN_PAGES.has(path) && (plan === "month" || plan === "year")) kept.set("plan", plan);
  const q = kept.toString();
  return `${url.origin}${path}${q ? `?${q}` : ""}`;
}

/**
 * page_referrer: our own allowlisted pages → their sanitized location; any other page of ours
 * → our origin only; another site → its origin only (never a path or query).
 */
export function sanitizeReferrer(referrer: string | null | undefined, ownOrigin: string): string {
  if (!referrer) return "";
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.origin === ownOrigin) return sanitizePageLocation(url.href) ?? `${ownOrigin}/`;
  return `${url.origin}/`;
}

/** A fixed title per page — document.title is never sent. */
export function analyticsPageTitle(pathname: string): string | null {
  const p = normalizePath(pathname);
  return p !== null && isAnalyticsRoute(p) ? `${ANALYTICS_ROUTES[p]} — TeamBalance Pro` : null;
}

// ---------------------------------------------------------------- consent (browser storage)

export type AnalyticsConsent = "granted" | "denied";
export const CONSENT_STORAGE_KEY = "tbp_analytics_consent_v1";
/** Same-tab notifications (other tabs get the "storage" event). */
export const CONSENT_CHANGE_EVENT = "tbp:analytics-consent";
export const OPEN_COOKIE_SETTINGS_EVENT = "tbp:cookie-settings";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** The stored choice; anything unreadable, malformed or unavailable → null (undecided → nothing loads). */
export function readConsent(storage: StorageLike | null | undefined): AnalyticsConsent | null {
  try {
    const raw = storage?.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const v = (JSON.parse(raw) as { status?: unknown })?.status;
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

/** Stores only the choice and when it was made (no identifier). Returns false when storage is unavailable. */
export function writeConsent(storage: StorageLike | null | undefined, status: AnalyticsConsent, now: Date = new Date()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ status, decidedAt: now.toISOString().slice(0, 10) }));
    return true;
  } catch {
    return false;
  }
}

/** GA4's own cookies for this property (_ga and _ga_<container>), to remove on withdrawal. */
export function gaCookieNames(measurementId: string): string[] {
  return ["_ga", `_ga_${measurementId.replace(/^G-/, "")}`];
}
