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
import { parseCanonicalGroupPath } from "@/lib/canonicalGroupPath";

export default function SiteHeader({ teamName }: { teamName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close menu on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Phase 2D.5D: this is the app's ONE SiteHeader instance, rendered
  // unconditionally by RootLayout for every route. RootLayout itself
  // cannot know it's under /g/[organizationSlug]/[groupSlug] (it sits
  // above those dynamic segments and receives no params for them), so
  // rather than add a second, Group-aware header lower in the tree
  // (which would produce two headers), this single instance determines
  // its own canonical-vs-legacy identity from its own client-side
  // pathname. See src/lib/canonicalGroupPath.ts and the Phase 2D.5D
  // report §C for the full reasoning.
  const canonical = useMemo(() => parseCanonicalGroupPath(pathname), [pathname]);

  // Canonical teamName comes only from this Group's own GroupSetting,
  // fetched via the tenant-scoped public API — never the `teamName`
  // prop (which is legacy AppSetting-sourced, global across all
  // Groups) and never another Group's value. Reset to "" the instant
  // the canonical target changes, so a previous Group's name can never
  // linger under a new Group's URL even for a moment.
  const [canonicalTeamName, setCanonicalTeamName] = useState("");

  useEffect(() => {
    if (!canonical) return;
    let cancelled = false;
    setCanonicalTeamName("");
    (async () => {
      try {
        const res = await fetch(
          `/api/public/${canonical.organizationSlug}/${canonical.groupSlug}/team-name`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!cancelled) {
          setCanonicalTeamName(typeof data?.teamName === "string" ? data.teamName : "");
        }
      } catch {
        if (!cancelled) setCanonicalTeamName("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canonical]);

  // Legacy routes (everything not under /g/...) are byte-identical to
  // before this phase: homeHref="/", playersHref="/players",
  // displayTeamName=the AppSetting-sourced prop.
  const homeHref = canonical ? `/g/${canonical.organizationSlug}/${canonical.groupSlug}` : "/";
  const playersHref = canonical ? `${homeHref}/players` : "/players";
  const displayTeamName = canonical ? canonicalTeamName : teamName;

  const links = useMemo(
    () => [
      { href: homeHref, label: "Home", active: pathname === homeHref },
      { href: playersHref, label: "Players", active: pathname?.startsWith(playersHref) },
      { href: "/admin", label: "Admin", active: pathname?.startsWith("/admin") },
    ],
    [pathname, homeHref, playersHref]
  );

  return (
    <header className="sticky top-0 z-50 border-b bg-gradient-to-r from-slate-900 to-slate-700 text-white print:hidden">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
        {/* Logo + Name (with click animation) */}
        <Link
          href={homeHref}
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
            <div className="text-lg font-semibold">{displayTeamName}</div>
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
