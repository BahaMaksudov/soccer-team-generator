"use client";

import { OPEN_COOKIE_SETTINGS_EVENT } from "@/lib/analytics/ga";
import { useAnalyticsEnvironment } from "./useAnalyticsEnvironment";

/**
 * The persistent "Cookie settings" link: reopens the analytics choice (GoogleAnalytics listens).
 * Renders only where analytics can run (Production hostname with the Measurement ID set).
 */
export default function CookieSettingsLink({ className }: { className?: string }) {
  const allowed = useAnalyticsEnvironment();
  if (!allowed) return null;
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT))} className={className}>
      Cookie settings
    </button>
  );
}
