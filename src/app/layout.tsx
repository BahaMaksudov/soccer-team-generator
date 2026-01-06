
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

import "./globals.css";
import SiteHeader from "@/components/SiteHeader";

export const metadata = {
  title: "Soccer Team Generator",
  description: "Pickup soccer team generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-900 relative overflow-x-hidden">
        
        {/* ✅ Background image (faded) */}
        <div
          className="fixed inset-0 -z-10 bg-center bg-cover"
          style={{
            backgroundImage: "url('/SoccerTeam.jpg')",
            opacity: 0.85,            // 👈 control fade here
          }}
        />

        {/* Optional white overlay to keep text readable */}
        <div className="fixed inset-0 -z-10 bg-white/70" />

        <SiteHeader />

        <main className="max-w-6xl mx-auto px-4 py-6">
          {children}
        </main>

        <footer className="border-t bg-white/80 mt-12 print:hidden">
          <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-600">
            © {new Date().getFullYear()} Pickup Soccer Team Generator
          </div>
        </footer>
      </body>
    </html>
  );
}


