"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import {
  analyticsPageTitle,
  CONSENT_CHANGE_EVENT,
  CONSENT_STORAGE_KEY,
  gaCookieNames,
  isAnalyticsRoute,
  OPEN_COOKIE_SETTINGS_EVENT,
  readConsent,
  sanitizePageLocation,
  sanitizeReferrer,
  writeConsent,
  type AnalyticsConsent,
} from "@/lib/analytics/ga";
import { cn } from "@/lib/cn";
import { MEASUREMENT_ID, safeStorage, useAnalyticsEnvironment } from "./useAnalyticsEnvironment";

/**
 * Google Analytics 4 with opt-in consent (rules: src/lib/analytics/ga.ts).
 *
 * Mounted once in the root layout. Renders nothing on the server and nothing until mounted,
 * so server and client HTML always match. Nothing is loaded from Google unless the deployment
 * gate passes, the visitor accepted, and the current page is allowlisted. Page views are sent
 * manually (send_page_view: false) with a rebuilt location/title — one per allowlisted
 * navigation.
 *
 * STRICT COLLECTION: GA's per-property kill switch window["ga-disable-<id>"] stays ON at all
 * times and is lifted only for the synchronous instant in which our own sanitized page_view is
 * handed to gtag. Everything GA would send by itself — Enhanced-measurement history page views
 * (which use the RAW browser URL and referrer), scrolls, outbound clicks, form and engagement
 * events — is therefore never sent, on any page, whatever the GA console settings are. The
 * script stays in memory across client-side navigation once loaded; the switch covers that too.
 * Remove this component from src/app/layout.tsx (or unset the variable) to disable analytics.
 */

type GaWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void; __tbpGaInitialized?: boolean } & Record<string, unknown>;

function setCollection(measurementId: string, on: boolean) {
  (window as unknown as GaWindow)[`ga-disable-${measurementId}`] = !on;
}

/** The ONLY way a hit leaves the browser: the switch is lifted for this one synchronous call. */
function sendPageView(measurementId: string, params: { page_location: string; page_title: string; page_referrer: string }) {
  const w = window as unknown as GaWindow;
  setCollection(measurementId, true);
  try {
    w.gtag?.("event", "page_view", params);
  } finally {
    setCollection(measurementId, false);
  }
}

function initGtag(measurementId: string) {
  const w = window as unknown as GaWindow;
  if (w.__tbpGaInitialized) return; // never twice (remounts, consent changes, React StrictMode)
  w.__tbpGaInitialized = true;
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer!.push(arguments);
  };
  // Loaded only after the visitor accepted analytics; advertising is never enabled.
  w.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  w.gtag("js", new Date());
  w.gtag("config", measurementId, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_flags: "SameSite=Lax;Secure",
    cookie_expires: 13 * 30 * 24 * 60 * 60, // ~13 months
    page_location: sanitizePageLocation(window.location.href) ?? `${window.location.origin}/`,
    page_title: analyticsPageTitle(window.location.pathname) ?? "TeamBalance Pro",
    page_referrer: sanitizeReferrer(document.referrer, window.location.origin),
  });
}

function deleteGaCookies(measurementId: string) {
  const host = window.location.hostname;
  const domains = ["", host, `.${host}`, `.${host.split(".").slice(-2).join(".")}`];
  for (const name of gaCookieNames(measurementId)) {
    for (const d of domains) document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ""}`;
  }
}

export default function GoogleAnalytics() {
  const pathname = usePathname() ?? "/";
  const allowed = useAnalyticsEnvironment();
  const [consent, setConsent] = useState<AnalyticsConsent | null | undefined>(undefined); // undefined = not read yet
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptWanted, setScriptWanted] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const lastSent = useRef<string | null>(null);
  const eligible = isAnalyticsRoute(pathname);

  // Stored choice + changes from other tabs, this tab, and "Cookie settings" links.
  useEffect(() => {
    setConsent(readConsent(safeStorage()));
    const reread = () => setConsent(readConsent(safeStorage()));
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONSENT_STORAGE_KEY) reread();
    };
    const onOpen = () => setSettingsOpen(true);
    window.addEventListener("storage", onStorage);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, onOpen);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, onOpen);
    };
  }, []);

  const active = Boolean(allowed && MEASUREMENT_ID && consent === "granted");

  // The kill switch is always on (lifted only inside sendPageView); the script is requested only on an allowlisted page.
  useEffect(() => {
    if (!MEASUREMENT_ID || allowed === null || consent === undefined) return;
    setCollection(MEASUREMENT_ID, false);
    if (active && eligible) {
      initGtag(MEASUREMENT_ID);
      setScriptWanted(true);
    }
  }, [active, eligible, allowed, consent]);

  // Exactly one page_view per allowlisted page (deduplicated: hydration, StrictMode, re-renders).
  useEffect(() => {
    const w = window as unknown as GaWindow;
    if (!active || !eligible || !MEASUREMENT_ID || !w.gtag || !scriptReady) {
      if (!eligible) lastSent.current = null; // coming back to an allowlisted page counts again
      return;
    }
    const location = sanitizePageLocation(window.location.href);
    const title = analyticsPageTitle(window.location.pathname);
    if (!location || !title || location === lastSent.current) return;
    const referrer = lastSent.current ?? sanitizeReferrer(document.referrer, window.location.origin);
    w.gtag("set", { page_location: location, page_title: title, page_referrer: referrer });
    sendPageView(MEASUREMENT_ID, { page_location: location, page_title: title, page_referrer: referrer });
    lastSent.current = location;
  }, [pathname, active, eligible, scriptReady]);

  const decide = useCallback((status: AnalyticsConsent) => {
    writeConsent(safeStorage(), status); // false when storage is blocked: the choice then applies to this visit only
    setConsent(status);
    setSettingsOpen(false);
    window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
    const w = window as unknown as GaWindow;
    if (status === "denied" && MEASUREMENT_ID) {
      setCollection(MEASUREMENT_ID, false);
      w.gtag?.("consent", "update", { analytics_storage: "denied" });
      deleteGaCookies(MEASUREMENT_ID);
      lastSent.current = null;
    } else if (status === "granted") {
      w.gtag?.("consent", "update", { analytics_storage: "granted" }); // re-accepted after declining on this page load
    }
  }, []);

  if (!allowed || !MEASUREMENT_ID || consent === undefined) return null;
  const showBanner = settingsOpen || (consent === null && eligible);
  return (
    <>
      {scriptWanted && <Script id="tbp-ga4" src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`} strategy="afterInteractive" onReady={() => setScriptReady(true)} />}
      {showBanner && <ConsentBanner current={consent} onDecide={decide} onClose={consent !== null ? () => setSettingsOpen(false) : undefined} />}
    </>
  );
}

function ConsentBanner({ current, onDecide, onClose }: { current: AnalyticsConsent | null; onDecide: (s: AnalyticsConsent) => void; onClose?: () => void }) {
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current !== null) firstButton.current?.focus(); // opened from "Cookie settings"
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, onClose]);
  const btn = "inline-flex min-h-11 flex-1 items-center justify-center rounded-tbp-md px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex-none";
  return (
    <section
      role="region"
      aria-labelledby="tbp-consent-title"
      className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-xl rounded-tbp-2xl border border-border bg-card p-4 font-body text-card-foreground shadow-lift sm:inset-x-6 sm:p-5"
    >
      <h2 id="tbp-consent-title" className="font-display text-base font-extrabold">
        Analytics cookies
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        With your permission we use Google Analytics cookies on our public pages to understand how visitors find and use TeamBalance Pro. They&apos;re optional and stay off unless you accept. We never use them on player pages or for advertising.{" "}
        <Link href="/privacy#cookies" className="font-semibold text-foreground underline underline-offset-2">
          Privacy Policy
        </Link>
      </p>
      {current !== null && <p className="mt-2 text-sm font-semibold">Analytics cookies are currently {current === "granted" ? "on" : "off"}.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button ref={firstButton} type="button" onClick={() => onDecide("granted")} className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/90")}>
          Accept
        </button>
        <button type="button" onClick={() => onDecide("denied")} className={cn(btn, "border border-input bg-card hover:bg-muted")}>
          Decline
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className={cn(btn, "text-muted-foreground hover:text-foreground")}>
            Close
          </button>
        )}
      </div>
    </section>
  );
}
