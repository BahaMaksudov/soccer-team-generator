import type { MetadataRoute } from "next";

/** Web app manifest (served at /manifest.webmanifest and linked automatically by Next.js). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TeamBalance Pro",
    short_name: "TeamBalance",
    description: "Balanced teams for pickup sports",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#005d37", // = --tbp-primary (oklch 0.42 0.1 158),
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
