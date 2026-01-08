// "use client";

// import Link from "next/link";
// import { usePathname } from "next/navigation";
// import { useEffect, useMemo, useState } from "react";

// export default function SiteHeader({ teamName }: { teamName: string }) {
//   const pathname = usePathname();
//   const [open, setOpen] = useState(false);

//   // Close menu on route change
//   useEffect(() => {
//     setOpen(false);
//   }, [pathname]);

//   const links = useMemo(
//     () => [
//       { href: "/", label: "Home", active: pathname === "/" },
//       { href: "/admin", label: "Admin", active: pathname?.startsWith("/admin") },
//     ],
//     [pathname]
//   );

//   return (
//     <header className="sticky top-0 z-50 border-b bg-gradient-to-r from-slate-900 to-slate-700 text-white print:hidden">
//       <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
//         {/* Logo + Name (with click animation) */}
//         <Link
//           href="/"
//           className="flex items-center gap-3 select-none"
//           aria-label="Go to home"
//         >
//           <img
//             src="/logo.png"
//             alt="Team Logo"
//             className="
//               h-14 w-auto max-w-[240px]
//               transition-transform duration-200
//               hover:scale-[1.03] active:scale-[0.97]
//             "
//           />
//           <div className="leading-tight">
//             <div className="text-lg font-semibold">{teamName}</div>
//             <div className="text-xs text-white/70">Pickup Soccer Team Generator</div>
//           </div>
//         </Link>

//         {/* Desktop nav */}
//         <nav className="ml-auto hidden sm:flex gap-2 text-sm">
//           {links.map((l) => (
//             <NavLink key={l.href} href={l.href} label={l.label} active={l.active} />
//           ))}
//         </nav>

//         {/* Mobile hamburger */}
//         <button
//           className="ml-auto sm:hidden inline-flex items-center justify-center rounded-md px-3 py-2
//                      hover:bg-white/10 active:bg-white/20 transition"
//           onClick={() => setOpen((v) => !v)}
//           aria-label="Toggle menu"
//           aria-expanded={open}
//         >
//           {/* Simple hamburger / X */}
//           <span className="text-sm font-semibold">{open ? "✕" : "☰"}</span>
//         </button>
//       </div>

//       {/* Mobile dropdown panel */}
//       {open && (
//         <div className="sm:hidden border-t border-white/10 bg-slate-800/60 backdrop-blur">
//           <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2">
//             {links.map((l) => (
//               <NavLink
//                 key={l.href}
//                 href={l.href}
//                 label={l.label}
//                 active={l.active}
//                 mobile
//               />
//             ))}
//           </div>
//         </div>
//       )}
//     </header>
//   );
// }

// function NavLink({
//   href,
//   label,
//   active,
//   mobile,
// }: {
//   href: string;
//   label: string;
//   active?: boolean;
//   mobile?: boolean;
// }) {
//   return (
//     <Link
//       href={href}
//       className={[
//         "rounded-md px-3 py-2 transition-colors",
//         mobile ? "text-sm" : "",
//         active
//           ? "bg-white/15 text-white ring-1 ring-white/20"
//           : "text-white/90 hover:text-white hover:bg-white/10 active:bg-white/20",
//       ].join(" ")}
//       aria-current={active ? "page" : undefined}
//     >
//       {label}
//     </Link>
//   );
// }

// "use client";

// import Link from "next/link";
// import { useEffect, useState } from "react";

// export default function SiteHeader() {
//   const [teamName, setTeamName] = useState("Loading…");

//   useEffect(() => {
//     fetch("/api/public/settings/team-name", { cache: "no-store" })
//       .then((r) => r.json())
//       .then((d) => setTeamName(d.teamName || ""))
//       .catch(() => setTeamName(""));
//   }, []);

//   return (
//     <header className="border-b bg-white">
//       <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
//         <img src="/logo.png" alt="Team Logo" className="h-10 w-10 object-contain" />

//         <div className="flex-1">
//           <div className="text-lg font-semibold">{teamName}</div>
//           <div className="text-xs text-gray-500">Pickup Soccer Team Generator</div>
//         </div>

//         <nav className="flex gap-4 text-sm">
//           <Link href="/">Home</Link>
//           <Link href="/players">Players</Link>
//           <Link href="/admin">Admin</Link>
//         </nav>
//       </div>
//     </header>
//   );
// }



"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function SiteHeader({ teamName }: { teamName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close menu on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const links = useMemo(
    () => [
      { href: "/", label: "Home", active: pathname === "/" },
      { href: "/players", label: "Players", active: pathname?.startsWith("/players") },
      { href: "/admin", label: "Admin", active: pathname?.startsWith("/admin") },
    ],
    [pathname]
  );

  return (
    <header className="sticky top-0 z-50 border-b bg-gradient-to-r from-slate-900 to-slate-700 text-white print:hidden">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
        {/* Logo + Name (with click animation) */}
        <Link
          href="/"
          className="flex items-center gap-3 select-none"
          aria-label="Go to home"
        >
          <img
            src="/logo.png"
            alt="Team Logo"
            className="
              h-14 w-auto max-w-[240px]
              transition-transform duration-200
              hover:scale-[1.03] active:scale-[0.97]
            "
          />
          <div className="leading-tight">
            <div className="text-lg font-semibold">{teamName}</div>
            <div className="text-xs text-white/70">Pickup Soccer Team Generator</div>
          </div>
        </Link>

        {/* Desktop nav */}
        <nav className="ml-auto hidden sm:flex gap-2 text-sm">
          {links.map((l) => (
            <NavLink key={l.href} href={l.href} label={l.label} active={l.active} />
          ))}
        </nav>

        {/* Mobile hamburger */}
        <button
          className="ml-auto sm:hidden inline-flex items-center justify-center rounded-md px-3 py-2
                     hover:bg-white/10 active:bg-white/20 transition"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={open}
        >
          {/* Simple hamburger / X */}
          <span className="text-sm font-semibold">{open ? "✕" : "☰"}</span>
        </button>
      </div>

      {/* Mobile dropdown panel */}
      {open && (
        <div className="sm:hidden border-t border-white/10 bg-slate-800/60 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2">
            {links.map((l) => (
              <NavLink
                key={l.href}
                href={l.href}
                label={l.label}
                active={l.active}
                mobile
              />
            ))}
          </div>
        </div>
      )}
    </header>
  );
}

function NavLink({
  href,
  label,
  active,
  mobile,
}: {
  href: string;
  label: string;
  active?: boolean;
  mobile?: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        "rounded-md px-3 py-2 transition-colors",
        mobile ? "text-sm" : "",
        active
          ? "bg-white/15 text-white ring-1 ring-white/20"
          : "text-white/90 hover:text-white hover:bg-white/10 active:bg-white/20",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
