import "./globals.css";
import SiteHeader from "@/components/SiteHeader";

export const metadata = {
  title: "Soccer Team Generator",
  description: "Pickup soccer team generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const teamName = process.env.TEAM_NAME ?? "New England Eagles";

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <SiteHeader teamName={teamName} />

        <main className="max-w-6xl mx-auto px-4 py-6">
          {children}
        </main>

        {/* Print-friendly footer: hide on print OR keep minimal */}
        <footer className="border-t bg-white mt-12 print:hidden">
          <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
            <div>© {new Date().getFullYear()} {teamName}. All rights reserved.</div>
            <div className="text-slate-500">Pickup Soccer Team Generator</div>
          </div>
        </footer>

        {/* Optional: Minimal print footer (shows only on print) */}
        <div className="hidden print:block text-xs text-slate-600 px-4 pb-4">
          © {new Date().getFullYear()} {teamName}
        </div>
      </body>
    </html>
  );
}


// import "./globals.css";
// import Link from "next/link";

// export const metadata = {
//   title: "Soccer Team Generator",
//   description: "Pickup soccer team generator",
// };

// export default function RootLayout({ children }: { children: React.ReactNode }) {
//   const teamName = process.env.TEAM_NAME ?? "Your Team Name";

//   return (
//     <html lang="en">
//       <body className="min-h-screen bg-slate-50 text-slate-900">
//         {/* Header */}
//         <header className="sticky top-0 z-50 border-b bg-gradient-to-r from-slate-900 to-slate-700 text-white">
//           <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
//             {/* Logo + Name */}
//             <Link href="/" className="flex items-center gap-3">
//               <img
//                 src="/logo.png"
//                 alt="Team Logo"
//                 className="h-14 w-auto max-w-[280px]"
//               />
//               <div className="leading-tight">
//                 <div className="text-lg font-semibold">{teamName}</div>
//                 <div className="text-xs text-white/70">
//                   Pickup Soccer Team Generator
//                 </div>
//               </div>
//             </Link>

//             {/* Nav */}
//             <nav className="ml-auto flex gap-2 text-sm">
//               <NavLink href="/" label="Home" />
//               <NavLink href="/admin" label="Admin" />
//             </nav>
//           </div>
//         </header>

//         {/* Page content */}
//         <main className="max-w-6xl mx-auto px-4 py-6">
//           {children}
//         </main>

//         {/* Footer */}
//         <footer className="border-t bg-white mt-12">
//           <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
//             <div>© {new Date().getFullYear()} {teamName}. All rights reserved.</div>
//             <div className="text-slate-500">Pickup Soccer Team Generator</div>
//           </div>
//         </footer>
//       </body>
//     </html>
//   );
// }

// function NavLink({ href, label }: { href: string; label: string }) {
//   return (
//     <Link
//       href={href}
//       className="
//         px-3 py-2 rounded-md
//         text-white/90
//         hover:text-white hover:bg-white/10
//         active:bg-white/20
//         transition-colors
//       "
//     >
//       {label}
//     </Link>
//   );
// }

