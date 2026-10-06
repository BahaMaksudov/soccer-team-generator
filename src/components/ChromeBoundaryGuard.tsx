"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isRedesignedPath, type ChromeMode } from "@/lib/chrome";

/**
 * UI-1 — the root layout is not re-rendered on client-side navigation, so the
 * chrome chosen on the server would stick when a soft navigation crosses
 * between the redesigned pages (homepage, auth) and the rest of the app. When that happens,
 * reload the (already updated) URL so the server renders the correct chrome.
 * Renders nothing; path-only decision.
 */
export default function ChromeBoundaryGuard({ mode }: { mode: ChromeMode }) {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname !== null && isRedesignedPath(pathname) !== (mode === "redesign")) window.location.reload();
  }, [pathname, mode]);
  return null;
}
