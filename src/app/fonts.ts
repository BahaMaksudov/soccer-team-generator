import localFont from "next/font/local";

/**
 * Self-hosted design-system fonts (previously downloaded from Google Fonts at
 * build time by the Google next/font loader). The files in
 * ./fonts are the exact .woff2 files Google Fonts served for these families
 * (byte-identical to the previous builds), licensed under the SIL Open Font
 * License 1.1 (./fonts/OFL-*.txt). The build no longer fetches anything from
 * Google: a malformed Google Fonts response broke a Production build (next/font
 * 15.5.9 assumes every font URL ends in .woff2/.woff/… and crashed on one that
 * didn't).
 *
 * Archivo (display, 600–900) and Manrope (body, 400–700) are variable fonts that
 * Google splits by script; next/font/local has no per-file unicode-range, so each
 * subset is its own face carrying Google's exact unicode-range. Only the latin
 * faces are preloaded and get the metric-adjusted fallback — the same as the
 * Google loader with `subsets: ["latin"]`. src/app/globals.css composes the
 * faces into --font-tbp-display / --font-tbp-body (latin last, then the fallback).
 *
 * next/font requires literal arguments: one call per face. To refresh the files,
 * download the same CSS2 URLs with a modern browser user agent and replace them.
 */

export const archivoVietnamese = localFont({
  src: "./fonts/archivo-vietnamese.woff2",
  weight: "600 900",
  style: "normal",
  display: "swap",
  variable: "--tbp-archivo-vietnamese",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" }],
});

export const archivoLatinExt = localFont({
  src: "./fonts/archivo-latin-ext.woff2",
  weight: "600 900",
  style: "normal",
  display: "swap",
  variable: "--tbp-archivo-latin-ext",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" }],
});

export const archivoLatin = localFont({
  src: "./fonts/archivo-latin.woff2",
  weight: "600 900",
  style: "normal",
  display: "swap",
  variable: "--tbp-archivo-latin",
  preload: true,
  adjustFontFallback: "Arial",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});

export const manropeCyrillicExt = localFont({
  src: "./fonts/manrope-cyrillic-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-cyrillic-ext",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" }],
});

export const manropeCyrillic = localFont({
  src: "./fonts/manrope-cyrillic.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-cyrillic",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" }],
});

export const manropeGreek = localFont({
  src: "./fonts/manrope-greek.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-greek",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" }],
});

export const manropeVietnamese = localFont({
  src: "./fonts/manrope-vietnamese.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-vietnamese",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" }],
});

export const manropeLatinExt = localFont({
  src: "./fonts/manrope-latin-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-latin-ext",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" }],
});

export const manropeLatin = localFont({
  src: "./fonts/manrope-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--tbp-manrope-latin",
  preload: true,
  adjustFontFallback: "Arial",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});

/** Every face's variable class + .tbp-fonts (globals.css composes them) — applied on <html> only. */
export const fontVariableClasses = ["tbp-fonts", archivoVietnamese.variable, archivoLatinExt.variable, archivoLatin.variable, manropeCyrillicExt.variable, manropeCyrillic.variable, manropeGreek.variable, manropeVietnamese.variable, manropeLatinExt.variable, manropeLatin.variable].join(" ");
