"use client";

import { useEffect, useState } from "react";
import { analyticsAllowed, validMeasurementId } from "@/lib/analytics/ga";

// Inlined at build time (must be literal property reads). Set in Vercel PRODUCTION only.
export const MEASUREMENT_ID = validMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
const VERCEL_ENV = process.env.NEXT_PUBLIC_VERCEL_ENV;

export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The GA deployment gate, evaluated in the browser only (hostname): null until mounted, so server and client HTML match. */
export function useAnalyticsEnvironment(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => setAllowed(analyticsAllowed({ measurementId: MEASUREMENT_ID, vercelEnv: VERCEL_ENV, hostname: window.location.hostname })), []);
  return allowed;
}
