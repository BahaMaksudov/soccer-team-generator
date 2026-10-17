"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * M12-A — the app-wide error boundary (any page below the root layout). Shows a
 * calm message instead of the framework error screen; never the error text or
 * stack (they may contain internal details). The digest is the correlation id
 * that also appears in the server log, so a support request can be traced.
 * Monitoring (e.g. Sentry) can hook into the useEffect below once approved.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(`[app] page error${error.digest ? ` (digest ${error.digest})` : ""}`);
  }, [error.digest]);
  return (
    <div role="alert" className="mx-auto my-16 max-w-md space-y-4 px-4 text-center">
      <h1 className="text-2xl font-extrabold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">This page couldn&apos;t be loaded. Nothing was changed. Please try again in a moment.</p>
      {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
      <div className="flex flex-col justify-center gap-2 sm:flex-row">
        <button type="button" onClick={() => reset()} className="inline-flex h-11 items-center justify-center rounded-tbp-md bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          Try again
        </button>
        <Link href="/" className="inline-flex h-11 items-center justify-center rounded-tbp-md border border-input px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          Go to the homepage
        </Link>
      </div>
    </div>
  );
}
