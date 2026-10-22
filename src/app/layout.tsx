
// import "./globals.css";
// import SiteHeader from "@/components/SiteHeader";

// export const metadata = {
//   title: "Soccer Team Generator",
//   description: "Pickup soccer team generator",
// };

// export default function RootLayout({ children }: { children: React.ReactNode }) {
//   return (
//     <html lang="en">
//       <body className="min-h-screen bg-slate-50 text-slate-900">
//         <SiteHeader />

//         <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>

//         <footer className="border-t bg-white mt-12 print:hidden">
//           <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
//             © {new Date().getFullYear()} Pickup Soccer Team Generator
//           </div>
//         </footer>
//       </body>
//     </html>
//   );
// }

// import "./globals.css";
// import SiteHeader from "@/components/SiteHeader";
// import { getTeamName } from "@/lib/settings";

// export const metadata = {
//   title: "Soccer Team Generator",
//   description: "Pickup soccer team generator",
// };

// export default function RootLayout({ children }: { children: React.ReactNode }) {
//   return (
//     <html lang="en">
//       <body className="min-h-screen text-slate-900 relative overflow-x-hidden">
        
//         {/* ✅ Background image (faded) */}
//         <div
//           className="fixed inset-0 -z-10 bg-center bg-cover"
//           style={{
//             backgroundImage: "url('/SoccerTeam.jpg')",
//             opacity: 0.85,            // 👈 control fade here
//           }}
//         />

//         {/* Optional white overlay to keep text readable */}
//         <div className="fixed inset-0 -z-10 bg-white/70" />

//         <SiteHeader teamName={getTeamName}/>

//         <main className="max-w-6xl mx-auto px-4 py-6">
//           {children}
//         </main>

//         <footer className="border-t bg-white/80 mt-12 print:hidden">
//           <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
//             © {new Date().getFullYear()} Pickup Soccer Team Generator
//           </div>
//         </footer>
//       </body>
//     </html>
//   );
// }


import "./globals.css";
import { fontVariableClasses } from "./fonts";
import { headers } from "next/headers";
import LegacyChrome from "@/components/LegacyChrome";
import ChromeBoundaryGuard from "@/components/ChromeBoundaryGuard";
import { CHROME_HEADER, chromeModeFromHeader } from "@/lib/chrome";
import { getTeamName } from "@/lib/settings";

// UI-0 — design-system fonts (Archivo display / Manrope body), self-hosted from
// src/app/fonts (next/font/local — no Google Fonts request at build or run time).
// Only the CSS VARIABLES are attached to <html>; globals.css composes them into
// --font-tbp-display / --font-tbp-body, used via the display/body utilities.
export const dynamic = "force-dynamic";
export const revalidate = 0;


// M7 — product branding is sport-neutral (Group pages carry their own sport wording).
export const metadata = {
  title: "TeamBalance Pro",
  description: "Balanced teams for pickup sports",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // UI-1 — server-side chrome decision from the middleware tag (src/lib/chrome.ts).
  const mode = chromeModeFromHeader((await headers()).get(CHROME_HEADER));
  const teamName = mode === "legacy" ? await getTeamName() : "";

  return (
    <html lang="en" className={fontVariableClasses}>
      <body className="min-h-screen text-slate-900 relative overflow-x-hidden">
        {/* UI-1/UI-2 — old global chrome for every route except the redesigned homepage and auth screens. */}
        <ChromeBoundaryGuard mode={mode} />
        {mode === "redesign" ? children : <LegacyChrome teamName={teamName}>{children}</LegacyChrome>}
      </body>
    </html>
  );
}