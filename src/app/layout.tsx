
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
import { Archivo, Manrope } from "next/font/google";
import SiteHeader from "@/components/SiteHeader";
import { getTeamName } from "@/lib/settings";

// UI-0 — design-system fonts, self-hosted by next/font at build time (no
// runtime Google Fonts request). Only the CSS VARIABLES are attached to
// <html>; nothing uses them until a redesigned component opts in via the
// display/body font-family utilities, so existing pages are unchanged.
const displayFont = Archivo({ subsets: ["latin"], weight: ["600", "700", "800", "900"], variable: "--font-tbp-display", display: "swap" });
const bodyFont = Manrope({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-tbp-body", display: "swap" });

export const dynamic = "force-dynamic";
export const revalidate = 0;


// M7 — product branding is sport-neutral (Group pages carry their own sport wording).
export const metadata = {
  title: "Team Balance Pro",
  description: "Balanced teams for pickup sports",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const teamName = await getTeamName();

  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body className="min-h-screen text-slate-900 relative overflow-x-hidden">
        <div
          className="fixed inset-0 -z-10 bg-center bg-cover"
          style={{
            backgroundImage: "url('/SoccerTeam.jpg')",
            opacity: 0.85,
          }}
        />

        <div className="fixed inset-0 -z-10 bg-white/70" />

        {/* ✅ pass the actual string */}
        <SiteHeader teamName={teamName} />

        <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>

        <footer className="border-t bg-white/80 mt-12 print:hidden">
          <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
            © {new Date().getFullYear()} Team Balance Pro
          </div>
        </footer>
      </body>
    </html>
  );
}