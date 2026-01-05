import "./globals.css";
import SiteHeader from "@/components/SiteHeader";

export const metadata = {
  title: "Soccer Team Generator",
  description: "Pickup soccer team generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <SiteHeader />

        <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>

        <footer className="border-t bg-white mt-12 print:hidden">
          <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
            © {new Date().getFullYear()} Pickup Soccer Team Generator
          </div>
        </footer>
      </body>
    </html>
  );
}




// import "./globals.css";
// import SiteHeader from "@/components/SiteHeader";

// export const metadata = {
//   title: "Soccer Team Generator",
//   description: "Pickup soccer team generator",
// };

// export default function RootLayout({ children }: { children: React.ReactNode }) {
//   const teamName = process.env.TEAM_NAME ?? "New England Eagles";

//   return (
//     <html lang="en">
//       <body className="min-h-screen bg-slate-50 text-slate-900">
//         <SiteHeader teamName={teamName} />

//         <main className="max-w-6xl mx-auto px-4 py-6">
//           {children}
//         </main>

//         {/* Print-friendly footer: hide on print OR keep minimal */}
//         <footer className="border-t bg-white mt-12 print:hidden">
//           <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
//             <div>© {new Date().getFullYear()} {teamName}. All rights reserved.</div>
//             <div className="text-slate-500">Pickup Soccer Team Generator</div>
//           </div>
//         </footer>

//         {/* Optional: Minimal print footer (shows only on print) */}
//         <div className="hidden print:block text-xs text-slate-600 px-4 pb-4">
//           © {new Date().getFullYear()} {teamName}
//         </div>
//       </body>
//     </html>
//   );
// }

