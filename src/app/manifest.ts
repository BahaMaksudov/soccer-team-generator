import type { MetadataRoute } from "next";
import { PWA_BACKGROUND_COLOR, PWA_START_URL, PWA_THEME_COLOR } from "@/lib/pwa";

/**
 * Web app manifest (served at /manifest.webmanifest and linked automatically by Next.js).
 * Installable on Android / desktop Chrome & Edge and via "Add to Home Screen" on iOS.
 * Icons are the existing brand artwork: icon-192/512 as-is ("any"), maskable-* re-laid out on the
 * brand tile color by scripts/generate-pwa-icons.mjs (never redrawn).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "TeamBalance Pro",
    short_name: "TeamBalance",
    description: "Balanced teams for pickup sports",
    lang: "en",
    dir: "ltr",
    start_url: PWA_START_URL,
    scope: "/",
    display: "standalone",
    // Not locked to portrait: the layouts are portrait-first, but tablets and desktop installs rotate freely.
    orientation: "any",
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    categories: ["sports", "productivity"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
