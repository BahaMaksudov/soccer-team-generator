import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import manifest from "@/app/manifest";
import { PWA_BACKGROUND_COLOR, PWA_START_URL, PWA_THEME_COLOR, pwaLaunchRedirect } from "@/lib/pwa";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
/** PNG width/height from the IHDR chunk. */
function pngSize(file: string) {
  const b = fs.readFileSync(path.join(process.cwd(), "public", file));
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("home-screen launch routing", () => {
  it("signed in → the app; signed out → the normal homepage; anything else untouched", () => {
    expect(pwaLaunchRedirect("/", "?source=pwa", true)).toBe("/admin");
    expect(pwaLaunchRedirect("/", "?source=pwa", false)).toBe("/");
    expect(pwaLaunchRedirect("/", "", true)).toBeNull(); // the website's "/" for browser visitors
    expect(pwaLaunchRedirect("/", "?source=newsletter", true)).toBeNull();
    expect(pwaLaunchRedirect("/pricing", "?source=pwa", true)).toBeNull();
  });
  it("the middleware applies it before anything else on '/'", () => {
    const mw = read("src/middleware.ts");
    expect(mw).toContain('if (req.nextUrl.pathname === "/" && req.nextUrl.searchParams.has("source"))');
    expect(mw).toContain("pwaLaunchRedirect(req.nextUrl.pathname, req.nextUrl.search, !!(await getToken({ req }))?.email)");
  });
});

describe("web app manifest", () => {
  const m = manifest();
  it("names, scope, start URL, display and colors", () => {
    expect(m).toMatchObject({ id: "/", name: "TeamBalance Pro", short_name: "TeamBalance", start_url: PWA_START_URL, scope: "/", display: "standalone" });
    expect(m.start_url!.startsWith("/")).toBe(true);
    expect(m.theme_color).toBe(PWA_THEME_COLOR);
    expect(m.background_color).toBe(PWA_BACKGROUND_COLOR);
  });
  it("icons: 192 + 512 'any' and 'maskable', each file present with its declared size", () => {
    const icons = m.icons!;
    for (const purpose of ["any", "maskable"]) for (const size of ["192x192", "512x512"]) expect(icons.some((i) => i.purpose === purpose && i.sizes === size)).toBe(true);
    for (const i of icons) {
      const { w, h } = pngSize(i.src.replace(/^\//, ""));
      expect(`${w}x${h}`).toBe(i.sizes);
    }
  });
});

describe("mobile metadata", () => {
  // The root layout imports next/font (Next.js-only), so its exports are checked as source.
  const layout = read("src/app/layout.tsx");
  it("Apple touch icon (180, full-bleed), app titles, no phone-number links", () => {
    expect(layout).toContain('applicationName: "TeamBalance Pro",');
    expect(layout).toContain('appleWebApp: { capable: true, title: "TeamBalance", statusBarStyle: "default" },');
    expect(layout).toContain("formatDetection: { telephone: false },");
    expect(layout).toContain('apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],');
    expect(pngSize("icons/apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
  });
  it("viewport: device width, zoom allowed, safe areas available, theme color = manifest", () => {
    const vp = layout.slice(layout.indexOf("export const viewport"), layout.indexOf("};", layout.indexOf("export const viewport")));
    expect(vp).toContain('width: "device-width",');
    expect(vp).toContain("initialScale: 1,");
    expect(vp).toContain('viewportFit: "cover",');
    expect(vp).toContain("themeColor: PWA_THEME_COLOR,");
    expect(vp).not.toMatch(/maximumScale|userScalable/);
  });
  it("metadata (manifest link, icons) is rendered in <head> for every client — not streamed into <body>", () => {
    expect(read("next.config.js")).toMatch(/htmlLimitedBots: \/\.\*\/,/);
  });
});

describe("no service worker in Phase 1 (nothing cached by the app)", () => {
  it("no worker file and no registration", () => {
    for (const f of ["public/sw.js", "public/service-worker.js", "src/app/sw.ts"]) expect(fs.existsSync(path.join(process.cwd(), f))).toBe(false);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const offenders = walk(path.join(process.cwd(), "src")).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.includes("__tests__") && /serviceWorker\.register/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("safe areas (notched iPhones, installed app)", () => {
  it("everything fixed to the bottom keeps clear of the home indicator; the app content clears the bottom navigation", () => {
    expect(read("src/components/app-shell/ShellClient.tsx")).toContain("pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]");
    expect(read("src/components/app/Dialog.tsx")).toContain("pb-[calc(1.25rem+env(safe-area-inset-bottom))]");
    expect(read("src/components/analytics/GoogleAnalytics.tsx")).toContain("bottom-[calc(0.75rem+env(safe-area-inset-bottom))]");
    expect(read("src/components/app-shell/AppShell.tsx")).toContain("pb-[calc(7rem+env(safe-area-inset-bottom))]");
    expect(read("src/app/layout.tsx")).toContain("pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]");
  });
});
