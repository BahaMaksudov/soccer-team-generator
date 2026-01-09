// "use client";

// import { useEffect, useMemo, useRef, useState } from "react";
// import { usePathname, useRouter, useSearchParams } from "next/navigation";
// import { positionLabel } from "@/lib/labels";

// type Position = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
// type Rating = "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";

// type Player = {
//   id: string;
//   firstName: string;
//   lastName: string;
//   position: Position;
//   rating: Rating;
//   stamina?: number | null;
//   isActive: boolean;
// };

// const POSITIONS: Position[] = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];

// const STATUS_OPTIONS = [
//   { key: "ALL", label: "All" },
//   { key: "ACTIVE", label: "Active" },
//   { key: "INACTIVE", label: "Inactive" },
// ] as const;

// type StatusKey = (typeof STATUS_OPTIONS)[number]["key"];
// type PositionKey = Position | "ALL";
// type MenuKey = "name" | "position" | "status" | null;

// /* ---------------- Scoring helpers ---------------- */

// const ratingWeight: Record<Rating, number> = {
//   FAIR: 1,
//   GOOD: 2,
//   VERY_GOOD: 3,
//   EXCELLENT: 4,
// };

// function clamp(n: number, min: number, max: number) {
//   return Math.max(min, Math.min(max, n));
// }

// function getStamina(p: Player): number {
//   const n = Number(p?.stamina);
//   return Number.isFinite(n) ? clamp(n, 1, 5) : 3;
// }

// function positionWeight(pos: Position): number {
//   switch (pos) {
//     case "DEFENDER":
//       return 1;
//     case "MIDFIELDER":
//     case "FORWARD":
//     case "GOALKEEPER":
//       return 2;
//     default:
//       return 1;
//   }
// }

// function impactScore(p: Player): number {
//   return ratingWeight[p.rating] * 10 + getStamina(p) * 2 + positionWeight(p.position) * 3;
// }

// /* ---------------- Debounce ---------------- */

// function useDebouncedValue<T>(value: T, delay: number) {
//   const [v, setV] = useState(value);
//   useEffect(() => {
//     const t = setTimeout(() => setV(value), delay);
//     return () => clearTimeout(t);
//   }, [value, delay]);
//   return v;
// }

// /* ---------------- URL helpers ---------------- */

// function normalizeStatus(v: string | null): StatusKey {
//   if (v === "ACTIVE" || v === "INACTIVE" || v === "ALL") return v;
//   return "ALL";
// }

// function normalizePosition(v: string | null): PositionKey {
//   if (!v) return "ALL";
//   if (v === "ALL") return "ALL";
//   if (POSITIONS.includes(v as Position)) return v as Position;
//   return "ALL";
// }

// function normalizeSort(v: string | null): "asc" | "desc" {
//   return v === "asc" ? "asc" : "desc";
// }

// /* ---------------- Page ---------------- */

// export default function PlayersPage() {
//   const router = useRouter();
//   const pathname = usePathname();
//   const searchParams = useSearchParams();

//   const [players, setPlayers] = useState<Player[]>([]);
//   const [loading, setLoading] = useState(true);

//   // ----- Init filters from URL -----
//   const [statusFilter, setStatusFilter] = useState<StatusKey>(() => normalizeStatus(searchParams.get("status")));
//   const [positionFilter, setPositionFilter] = useState<PositionKey>(() => normalizePosition(searchParams.get("pos")));
//   const [scoreSort, setScoreSort] = useState<"asc" | "desc">(() => normalizeSort(searchParams.get("sort")));
//   const [nameQuery, setNameQuery] = useState(() => searchParams.get("name") ?? "");

//   // Debounced name used for filtering + URL updates
//   const debouncedName = useDebouncedValue(nameQuery, 250);

//   // Menus + drawer
//   const [openMenu, setOpenMenu] = useState<MenuKey>(null);
//   const [drawerOpen, setDrawerOpen] = useState(false);

//   const menuRef = useRef<HTMLDivElement | null>(null);
//   const nameInputRef = useRef<HTMLInputElement | null>(null);

//   // for keyboard navigation inside menu items
//   const menuItemsRef = useRef<HTMLButtonElement[]>([]);
//   const [menuFocusIndex, setMenuFocusIndex] = useState(0);

//   // Close dropdown menus on outside click
//   useEffect(() => {
//     function close(e: MouseEvent) {
//       if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
//         setOpenMenu(null);
//       }
//     }
//     document.addEventListener("mousedown", close);
//     return () => document.removeEventListener("mousedown", close);
//   }, []);

//   // Load players
//   useEffect(() => {
//     (async () => {
//       const res = await fetch("/api/public/players", { cache: "no-store" });
//       const data = await res.json();
//       setPlayers(data || []);
//       setLoading(false);
//     })();
//   }, []);

//   // Keep state in sync if user navigates with back/forward or shares link
//   useEffect(() => {
//     setStatusFilter(normalizeStatus(searchParams.get("status")));
//     setPositionFilter(normalizePosition(searchParams.get("pos")));
//     setScoreSort(normalizeSort(searchParams.get("sort")));
//     setNameQuery(searchParams.get("name") ?? "");
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [searchParams]);

//   // Push filters into URL (debounced for name)
//   useEffect(() => {
//     const params = new URLSearchParams(searchParams.toString());

//     // name
//     const name = debouncedName.trim();
//     if (name) params.set("name", name);
//     else params.delete("name");

//     // position
//     if (positionFilter !== "ALL") params.set("pos", positionFilter);
//     else params.delete("pos");

//     // status
//     if (statusFilter !== "ALL") params.set("status", statusFilter);
//     else params.delete("status");

//     // sort (persist always, so shared link keeps it)
//     params.set("sort", scoreSort);

//     const qs = params.toString();
//     router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [debouncedName, positionFilter, statusFilter, scoreSort]);

//   // Reset menu refs on open
//   useEffect(() => {
//     menuItemsRef.current = [];
//     setMenuFocusIndex(0);
//     if (openMenu === "name") {
//       setTimeout(() => nameInputRef.current?.focus(), 0);
//     }
//   }, [openMenu]);

//   function closeAllOverlays() {
//     setOpenMenu(null);
//     setDrawerOpen(false);
//   }

//   function toggleMenu(key: MenuKey) {
//     setOpenMenu((prev) => (prev === key ? null : key));
//   }

//   /* ---------------- Keyboard helpers ---------------- */

//   function onHeaderKeyDown(e: React.KeyboardEvent, menu: MenuKey) {
//     if (e.key === "Enter" || e.key === " ") {
//       e.preventDefault();
//       toggleMenu(menu);
//     }
//     if (e.key === "Escape") {
//       e.preventDefault();
//       setOpenMenu(null);
//     }
//     if (e.key === "ArrowDown") {
//       e.preventDefault();
//       toggleMenu(menu);
//       setTimeout(() => {
//         if (menu === "name") nameInputRef.current?.focus();
//         else menuItemsRef.current[0]?.focus();
//       }, 0);
//     }
//   }

//   function onMenuKeyDown(e: React.KeyboardEvent) {
//     if (e.key === "Escape") {
//       e.preventDefault();
//       setOpenMenu(null);
//       return;
//     }
//     if (e.key === "ArrowDown") {
//       e.preventDefault();
//       const next = Math.min(menuItemsRef.current.length - 1, menuFocusIndex + 1);
//       setMenuFocusIndex(next);
//       menuItemsRef.current[next]?.focus();
//       return;
//     }
//     if (e.key === "ArrowUp") {
//       e.preventDefault();
//       const prev = Math.max(0, menuFocusIndex - 1);
//       setMenuFocusIndex(prev);
//       menuItemsRef.current[prev]?.focus();
//       return;
//     }
//     if (e.key === "Home") {
//       e.preventDefault();
//       setMenuFocusIndex(0);
//       menuItemsRef.current[0]?.focus();
//       return;
//     }
//     if (e.key === "End") {
//       e.preventDefault();
//       const last = Math.max(0, menuItemsRef.current.length - 1);
//       setMenuFocusIndex(last);
//       menuItemsRef.current[last]?.focus();
//       return;
//     }
//   }

//   /* ---------------- Filtering + sorting ---------------- */

//   const rows = useMemo(() => {
//     let list = players.map((p) => ({
//       ...p,
//       fullName: `${p.firstName} ${p.lastName}`,
//       score: impactScore(p),
//     }));

//     if (statusFilter !== "ALL") {
//       list = list.filter((p) => p.isActive === (statusFilter === "ACTIVE"));
//     }

//     if (positionFilter !== "ALL") {
//       list = list.filter((p) => p.position === positionFilter);
//     }

//     const q = debouncedName.trim().toLowerCase();
//     if (q) {
//       list = list.filter((p) => p.fullName.toLowerCase().includes(q));
//     }

//     list.sort((a, b) => (scoreSort === "desc" ? b.score - a.score : a.score - b.score));
//     return list;
//   }, [players, statusFilter, positionFilter, debouncedName, scoreSort]);

//   const top5 = rows.slice(0, 5);

//   /* ---------------- Chips ---------------- */

//   const chips = useMemo(() => {
//     const list: { key: string; label: string; onClear: () => void }[] = [];

//     if (debouncedName.trim()) {
//       list.push({
//         key: "name",
//         label: `Name: "${debouncedName.trim()}"`,
//         onClear: () => setNameQuery(""),
//       });
//     }
//     if (positionFilter !== "ALL") {
//       list.push({
//         key: "pos",
//         label: `Position: ${positionLabel(positionFilter)}`,
//         onClear: () => setPositionFilter("ALL"),
//       });
//     }
//     if (statusFilter !== "ALL") {
//       list.push({
//         key: "status",
//         label: `Status: ${statusFilter === "ACTIVE" ? "Active" : "Inactive"}`,
//         onClear: () => setStatusFilter("ALL"),
//       });
//     }
//     if (scoreSort !== "desc") {
//       list.push({
//         key: "sort",
//         label: `Sort: Low → High`,
//         onClear: () => setScoreSort("desc"),
//       });
//     }

//     return list;
//   }, [debouncedName, positionFilter, statusFilter, scoreSort]);

//   function clearAllFilters() {
//     setNameQuery("");
//     setPositionFilter("ALL");
//     setStatusFilter("ALL");
//     setScoreSort("desc");
//   }

//   function copyShareLink() {
//     const url = window.location.href;
//     navigator.clipboard?.writeText(url);
//   }

//   /* ---------------- UI helpers ---------------- */

//   function HeaderCell({
//     onClick,
//     onKeyDown,
//     children,
//     alignRight,
//   }: {
//     onClick?: () => void;
//     onKeyDown?: (e: React.KeyboardEvent) => void;
//     children: React.ReactNode;
//     alignRight?: boolean;
//   }) {
//     return (
//       <th
//         role="button"
//         tabIndex={0}
//         onClick={onClick}
//         onKeyDown={onKeyDown}
//         className={`p-3 text-left cursor-pointer select-none relative outline-none focus:ring-2 focus:ring-white/40 ${
//           alignRight ? "text-right" : ""
//         }`}
//       >
//         {children}
//       </th>
//     );
//   }

//   function Menu({ children }: { children: React.ReactNode }) {
//     return (
//       <div
//         ref={menuRef}
//         onKeyDown={onMenuKeyDown}
//         className="absolute right-2 top-full mt-2 w-56 rounded-lg border bg-white shadow-lg z-30 p-2"
//         onMouseDown={(e) => e.stopPropagation()}
//       onClick={(e) => e.stopPropagation()}
//       >
//         {children}
//       </div>
//     );
//   }

//   function MenuItem({
//     active,
//     onClick,
//     children,
//     index,
//   }: {
//     active?: boolean;
//     onClick: () => void;
//     children: React.ReactNode;
//     index: number;
//   }) {
//     return (
//       <button
//         ref={(el) => {
//           if (el) menuItemsRef.current[index] = el;
//         }}
//         onFocus={() => setMenuFocusIndex(index)}
//         onClick={onClick}
//         className={`w-full text-left px-3 py-2 rounded-md text-sm ${
//           active ? "bg-slate-900 text-white" : "hover:bg-slate-100 text-slate-800"
//         }`}
//       >
//         {children}
//       </button>
//     );
//   }

//   return (
//     <div className="rounded-2xl border bg-white shadow-sm p-0 overflow-hidden">
//       {/* ✅ Sticky PAGE header (NOT the table header) */}
//       <div className="sticky top-0 z-30 bg-white border-b">
//         <div className="p-5 space-y-3">
//           {/* Title row */}
//           <div className="flex items-start justify-between gap-3">
//             <div>
//               <h1 className="text-2xl font-semibold">All Players</h1>
//               <p className="text-xs text-slate-600">
//                 Score = rating×10 + stamina×2 + positionWeight×3
//               </p>
//             </div>

//             <div className="flex items-center gap-3">
//               <div className="text-sm text-slate-600">Showing {rows.length} player(s)</div>

//               {/* Copy share link */}
//               <button
//                 className="hidden md:inline border rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
//                 onClick={copyShareLink}
//                 title="Copy shareable link"
//               >
//                 Copy link
//               </button>

//               {/* Mobile Filters button */}
//               <button
//                 className="md:hidden border rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
//                 onClick={() => setDrawerOpen(true)}
//               >
//                 Filters
//               </button>
//             </div>
//           </div>

//           {/* ✅ Active filter chips */}
//           <div className="flex flex-wrap items-center gap-2">
//             {chips.length === 0 ? (
//               <span className="text-xs text-slate-500">No filters applied</span>
//             ) : (
//               <>
//                 {chips.map((c) => (
//                   <button
//                     key={c.key}
//                     className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-slate-50 text-xs hover:bg-slate-100"
//                     onClick={c.onClear}
//                     title="Click to clear"
//                   >
//                     <span className="text-slate-700">{c.label}</span>
//                     <span className="text-slate-500">✕</span>
//                   </button>
//                 ))}

//                 <button
//                   className="text-xs underline text-slate-600 ml-1"
//                   onClick={clearAllFilters}
//                 >
//                   Clear all
//                 </button>
//               </>
//             )}
//           </div>
//         </div>
//       </div>

//       <div className="p-5 space-y-6">
//         {/* Top 5 cards */}
//         <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
//           {top5.map((p) => (
//             <div key={p.id} className="border rounded-xl p-3 bg-slate-50">
//               <div className="font-semibold">{p.fullName}</div>
//               <div className="text-xs text-slate-600">
//                 {positionLabel(p.position)} · {p.isActive ? "Active" : "Inactive"}
//               </div>
//               <div className="mt-2 text-lg font-bold">{p.score}</div>
//             </div>
//           ))}
//         </div>

//         {/* Table */}
//         <div className="border rounded-xl overflow-hidden">
//           <div className="overflow-x-auto">
//             <table className="w-full text-sm">
//               {/* ❌ NOT sticky */}
//               <thead className="bg-slate-900 text-white">
//                 <tr>
//                   <HeaderCell
//                     onClick={() => toggleMenu("name")}
//                     onKeyDown={(e) => onHeaderKeyDown(e, "name")}
//                   >
//                     <span className="hidden md:inline">Name ▾</span>
//                     <span className="md:hidden">Name</span>

//                     {openMenu === "name" && (
//                       <Menu>
//                         <div className="px-1 pb-2 text-xs text-slate-500">Filter by name</div>
//                         <input
//                           ref={nameInputRef}
//                           className="w-full border rounded-md px-2 py-1 text-sm text-slate-900"
//                           placeholder="Search name..."
//                           value={nameQuery}
//                           onChange={(e) => setNameQuery(e.target.value)}
//                         />
//                         <div className="flex justify-between pt-2">
//                           <button
//                             className="text-xs underline text-slate-600"
//                             onClick={() => setNameQuery("")}
//                           >
//                             Clear
//                           </button>
//                           <button
//                             className="text-xs underline text-slate-600"
//                             onClick={copyShareLink}
//                             title="Copy shareable link"
//                           >
//                             Copy link
//                           </button>
//                         </div>
//                       </Menu>
//                     )}
//                   </HeaderCell>

//                   <HeaderCell
//                     onClick={() => toggleMenu("position")}
//                     onKeyDown={(e) => onHeaderKeyDown(e, "position")}
//                   >
//                     <span className="hidden md:inline">Position ▾</span>
//                     <span className="md:hidden">Position</span>

//                     {openMenu === "position" && (
//                       <Menu>
//                         <div className="px-1 pb-2 text-xs text-slate-500">Filter by position</div>
//                         <MenuItem
//                           index={0}
//                           active={positionFilter === "ALL"}
//                           onClick={() => {
//                             setPositionFilter("ALL");
//                             setOpenMenu(null);
//                           }}
//                         >
//                           All
//                         </MenuItem>

//                         {POSITIONS.map((p, i) => (
//                           <MenuItem
//                             key={p}
//                             index={i + 1}
//                             active={positionFilter === p}
//                             onClick={() => {
//                               setPositionFilter(p);
//                               setOpenMenu(null);
//                             }}
//                           >
//                             {positionLabel(p)}
//                           </MenuItem>
//                         ))}
//                       </Menu>
//                     )}
//                   </HeaderCell>

//                   <HeaderCell
//                     onClick={() => setScoreSort(scoreSort === "desc" ? "asc" : "desc")}
//                     onKeyDown={(e) => {
//                       if (e.key === "Enter" || e.key === " ") {
//                         e.preventDefault();
//                         setScoreSort(scoreSort === "desc" ? "asc" : "desc");
//                       }
//                     }}
//                   >
//                     Score {scoreSort === "desc" ? "↓" : "↑"}
//                   </HeaderCell>

//                   <HeaderCell
//                     onClick={() => toggleMenu("status")}
//                     onKeyDown={(e) => onHeaderKeyDown(e, "status")}
//                   >
//                     <span className="hidden md:inline">Status ▾</span>
//                     <span className="md:hidden">Status</span>

//                     {openMenu === "status" && (
//                       <Menu>
//                         <div className="px-1 pb-2 text-xs text-slate-500">Filter by status</div>
//                         {STATUS_OPTIONS.map((s, i) => (
//                           <MenuItem
//                             key={s.key}
//                             index={i}
//                             active={statusFilter === s.key}
//                             onClick={() => {
//                               setStatusFilter(s.key);
//                               setOpenMenu(null);
//                             }}
//                           >
//                             {s.label}
//                           </MenuItem>
//                         ))}
//                       </Menu>
//                     )}
//                   </HeaderCell>
//                 </tr>
//               </thead>

//               <tbody>
//                 {rows.map((p) => (
//                   <tr key={p.id} className="border-t hover:bg-slate-50">
//                     <td className="p-3">{p.fullName}</td>
//                     <td className="p-3">{positionLabel(p.position)}</td>
//                     <td className="p-3 font-semibold">{p.score}</td>
//                     <td className="p-3">
//                       <span
//                         className={`px-2 py-1 rounded-full text-xs border ${
//                           p.isActive
//                             ? "bg-emerald-50 text-emerald-700 border-emerald-200"
//                             : "bg-slate-50 text-slate-600 border-slate-200"
//                         }`}
//                       >
//                         {p.isActive ? "Active" : "Inactive"}
//                       </span>
//                     </td>
//                   </tr>
//                 ))}

//                 {!loading && rows.length === 0 && (
//                   <tr>
//                     <td colSpan={4} className="p-4 text-slate-600">
//                       No players match filters
//                     </td>
//                   </tr>
//                 )}
//               </tbody>
//             </table>
//           </div>
//         </div>
//       </div>

//       {/* ---------------- Mobile Filter Drawer ---------------- */}
//       {drawerOpen && (
//         <div className="fixed inset-0 z-40 md:hidden">
//           {/* overlay */}
//           <button
//             className="absolute inset-0 bg-black/40"
//             onClick={() => setDrawerOpen(false)}
//             aria-label="Close filters"
//           />

//           {/* drawer */}
//           <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm bg-white shadow-xl p-4 overflow-y-auto">
//             <div className="flex items-center justify-between">
//               <div className="text-lg font-semibold">Filters</div>
//               <button className="text-sm underline" onClick={() => setDrawerOpen(false)}>
//                 Close
//               </button>
//             </div>

//             <div className="mt-4 space-y-4">
//               {/* Name */}
//               <div>
//                 <div className="text-sm font-medium mb-1">Name</div>
//                 <input
//                   className="w-full border rounded-lg px-3 py-2 text-sm"
//                   placeholder="Search name..."
//                   value={nameQuery}
//                   onChange={(e) => setNameQuery(e.target.value)}
//                 />
//                 <div className="text-xs text-slate-500 mt-1">
//                   Debounced search (fast for big lists)
//                 </div>
//               </div>

//               {/* Position */}
//               <div>
//                 <div className="text-sm font-medium mb-1">Position</div>
//                 <select
//                   className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
//                   value={positionFilter}
//                   onChange={(e) => setPositionFilter(e.target.value as PositionKey)}
//                 >
//                   <option value="ALL">All</option>
//                   {POSITIONS.map((p) => (
//                     <option key={p} value={p}>
//                       {positionLabel(p)}
//                     </option>
//                   ))}
//                 </select>
//               </div>

//               {/* Status */}
//               <div>
//                 <div className="text-sm font-medium mb-1">Status</div>
//                 <select
//                   className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
//                   value={statusFilter}
//                   onChange={(e) => setStatusFilter(e.target.value as StatusKey)}
//                 >
//                   {STATUS_OPTIONS.map((s) => (
//                     <option key={s.key} value={s.key}>
//                       {s.label}
//                     </option>
//                   ))}
//                 </select>
//               </div>

//               {/* Sort */}
//               <div>
//                 <div className="text-sm font-medium mb-1">Sort by score</div>
//                 <div className="flex gap-2">
//                   <button
//                     className={`flex-1 border rounded-lg px-3 py-2 text-sm ${
//                       scoreSort === "desc" ? "bg-slate-900 text-white" : "bg-white"
//                     }`}
//                     onClick={() => setScoreSort("desc")}
//                   >
//                     High → Low
//                   </button>
//                   <button
//                     className={`flex-1 border rounded-lg px-3 py-2 text-sm ${
//                       scoreSort === "asc" ? "bg-slate-900 text-white" : "bg-white"
//                     }`}
//                     onClick={() => setScoreSort("asc")}
//                   >
//                     Low → High
//                   </button>
//                 </div>
//               </div>

//               {/* Chips preview in drawer */}
//               <div className="pt-1">
//                 <div className="text-sm font-medium mb-2">Active filters</div>
//                 <div className="flex flex-wrap gap-2">
//                   {chips.length === 0 ? (
//                     <span className="text-xs text-slate-500">No filters applied</span>
//                   ) : (
//                     chips.map((c) => (
//                       <button
//                         key={c.key}
//                         className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-slate-50 text-xs hover:bg-slate-100"
//                         onClick={c.onClear}
//                       >
//                         <span className="text-slate-700">{c.label}</span>
//                         <span className="text-slate-500">✕</span>
//                       </button>
//                     ))
//                   )}
//                 </div>
//               </div>

//               {/* Actions */}
//               <div className="pt-2 flex gap-2">
//                 <button className="flex-1 border rounded-lg px-3 py-2 text-sm" onClick={clearAllFilters}>
//                   Reset
//                 </button>
//                 <button
//                   className="flex-1 bg-slate-900 text-white rounded-lg px-3 py-2 text-sm"
//                   onClick={() => setDrawerOpen(false)}
//                 >
//                   Apply
//                 </button>
//               </div>

//               <button className="w-full text-xs underline text-slate-500 pt-2" onClick={closeAllOverlays}>
//                 Close all menus
//               </button>
//             </div>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }


"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { positionLabel } from "@/lib/labels";

type Position = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";
type Rating = "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  position: Position;
  rating: Rating;
  stamina?: number | null;
  isActive: boolean;
};

const POSITIONS: Position[] = ["GOALKEEPER", "DEFENDER", "MIDFIELDER", "FORWARD"];

const STATUS_OPTIONS = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "INACTIVE", label: "Inactive" },
] as const;

type StatusKey = (typeof STATUS_OPTIONS)[number]["key"];
type PositionKey = Position | "ALL";
type MenuKey = "name" | "position" | "status" | null;

/* ---------------- Scoring helpers ---------------- */

const ratingWeight: Record<Rating, number> = {
  FAIR: 1,
  GOOD: 2,
  VERY_GOOD: 3,
  EXCELLENT: 4,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getStamina(p: Player): number {
  const n = Number(p?.stamina);
  return Number.isFinite(n) ? clamp(n, 1, 5) : 3;
}

function positionWeight(pos: Position): number {
  switch (pos) {
    case "DEFENDER":
      return 1;
    case "MIDFIELDER":
    case "FORWARD":
    case "GOALKEEPER":
      return 2;
    default:
      return 1;
  }
}

function impactScore(p: Player): number {
  const rw = ratingWeight[p.rating] ?? 2;
  return rw * 10 + getStamina(p) * 2 + positionWeight(p.position) * 3;
}

/* ---------------- Debounce ---------------- */

function useDebouncedValue<T>(value: T, delay: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/* ---------------- URL helpers ---------------- */

function normalizeStatus(v: string | null): StatusKey {
  if (v === "ACTIVE" || v === "INACTIVE" || v === "ALL") return v;
  return "ALL";
}

function normalizePosition(v: string | null): PositionKey {
  if (!v) return "ALL";
  if (v === "ALL") return "ALL";
  if (POSITIONS.includes(v as Position)) return v as Position;
  return "ALL";
}

function normalizeSort(v: string | null): "asc" | "desc" {
  return v === "asc" ? "asc" : "desc";
}

function readFiltersFromLocation() {
  if (typeof window === "undefined") {
    return {
      status: "ALL" as StatusKey,
      pos: "ALL" as PositionKey,
      sort: "desc" as "asc" | "desc",
      name: "",
    };
  }
  const sp = new URLSearchParams(window.location.search);
  return {
    status: normalizeStatus(sp.get("status")),
    pos: normalizePosition(sp.get("pos")),
    sort: normalizeSort(sp.get("sort")),
    name: sp.get("name") ?? "",
  };
}

/* ---------------- Popover (portal) ---------------- */

function HeaderPopover({
  open,
  anchorEl,
  title,
  onClose,
  children,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open || !anchorEl) return;

    const compute = () => {
      const r = anchorEl.getBoundingClientRect();
      const desiredW = clamp(r.width, 220, 320);

      // Measure popover
      const popH = popRef.current?.offsetHeight ?? 220;
      const popW = popRef.current?.offsetWidth ?? desiredW;

      // Prefer below, flip above if needed
      let top = r.bottom + 8;
      if (top + popH > window.innerHeight - 8) top = r.top - popH - 8;
      top = clamp(top, 8, window.innerHeight - popH - 8);

      // Align left with header, clamp to viewport
      let left = r.left;
      left = clamp(left, 8, window.innerWidth - popW - 8);

      setPos({ top, left, width: popW });
    };

    // 2-frame compute so height is accurate after render
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(compute);
      return () => cancelAnimationFrame(raf2);
    });

    const onResizeOrScroll = () => {
      setPos(null);
      requestAnimationFrame(compute);
    };

    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);

    return () => {
      cancelAnimationFrame(raf1);
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
    };
  }, [open, anchorEl]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div data-popover-root="true">
      {/* overlay */}
      <button
        className="fixed inset-0 z-[60] cursor-default"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        ref={popRef}
        className="fixed z-[70] rounded-xl border bg-white shadow-lg p-3"
        style={{
          top: pos?.top ?? 80,
          left: pos?.left ?? 12,
          width: pos?.width ?? 260,
          maxHeight: "60vh",
          overflow: "auto",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold text-slate-700 mb-2">{title}</div>
        {children}
      </div>
    </div>,
    document.body
  );
}

/* ---------------- Page ---------------- */

export default function PlayersClientPage() {
  const router = useRouter();
  const pathname = usePathname();

  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters (init safely; then sync from URL once mounted)
  const [statusFilter, setStatusFilter] = useState<StatusKey>("ALL");
  const [positionFilter, setPositionFilter] = useState<PositionKey>("ALL");
  const [scoreSort, setScoreSort] = useState<"asc" | "desc">("desc");
  const [nameQuery, setNameQuery] = useState("");

  // Debounced name used for filtering + URL updates
  const debouncedName = useDebouncedValue(nameQuery, 250);

  // Popovers + drawer
  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Load players
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/public/players", { cache: "no-store" });
        const data = await res.json();
        setPlayers(Array.isArray(data) ? data : []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Read URL filters once on mount
  useEffect(() => {
    const f = readFiltersFromLocation();
    setStatusFilter(f.status);
    setPositionFilter(f.pos);
    setScoreSort(f.sort);
    setNameQuery(f.name);
  }, []);

  // Sync if user uses back/forward
  useEffect(() => {
    const onPop = () => {
      const f = readFiltersFromLocation();
      setStatusFilter(f.status);
      setPositionFilter(f.pos);
      setScoreSort(f.sort);
      setNameQuery(f.name);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Push filters into URL (debounced for name)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);

    const name = debouncedName.trim();
    if (name) params.set("name", name);
    else params.delete("name");

    if (positionFilter !== "ALL") params.set("pos", positionFilter);
    else params.delete("pos");

    if (statusFilter !== "ALL") params.set("status", statusFilter);
    else params.delete("status");

    params.set("sort", scoreSort);

    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedName, positionFilter, statusFilter, scoreSort]);

  // Focus name input when opening name popover
  useEffect(() => {
    if (openMenu === "name") {
      setTimeout(() => nameInputRef.current?.focus(), 0);
    }
  }, [openMenu]);

  function closeAllOverlays() {
    setOpenMenu(null);
    setDrawerOpen(false);
    setAnchorEl(null);
  }

  function toggleMenu(key: MenuKey, el?: HTMLElement) {
    setOpenMenu((prev) => {
      const next = prev === key ? null : key;
      return next;
    });
    if (el) setAnchorEl(el);
  }

  /* ---------------- Filtering + sorting ---------------- */

  const rows = useMemo(() => {
    let list = players.map((p) => ({
      ...p,
      fullName: `${p.firstName} ${p.lastName}`,
      score: impactScore(p),
    }));

    if (statusFilter !== "ALL") {
      list = list.filter((p) => p.isActive === (statusFilter === "ACTIVE"));
    }

    if (positionFilter !== "ALL") {
      list = list.filter((p) => p.position === positionFilter);
    }

    const q = debouncedName.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => p.fullName.toLowerCase().includes(q));
    }

    list.sort((a, b) => (scoreSort === "desc" ? b.score - a.score : a.score - b.score));
    return list;
  }, [players, statusFilter, positionFilter, debouncedName, scoreSort]);

  const top5 = rows.slice(0, 5);

  /* ---------------- Chips ---------------- */

  const chips = useMemo(() => {
    const list: { key: string; label: string; onClear: () => void }[] = [];

    if (debouncedName.trim()) {
      list.push({
        key: "name",
        label: `Name: "${debouncedName.trim()}"`,
        onClear: () => setNameQuery(""),
      });
    }
    if (positionFilter !== "ALL") {
      list.push({
        key: "pos",
        label: `Position: ${positionLabel(positionFilter)}`,
        onClear: () => setPositionFilter("ALL"),
      });
    }
    if (statusFilter !== "ALL") {
      list.push({
        key: "status",
        label: `Status: ${statusFilter === "ACTIVE" ? "Active" : "Inactive"}`,
        onClear: () => setStatusFilter("ALL"),
      });
    }
    if (scoreSort !== "desc") {
      list.push({
        key: "sort",
        label: `Sort: Low → High`,
        onClear: () => setScoreSort("desc"),
      });
    }

    return list;
  }, [debouncedName, positionFilter, statusFilter, scoreSort]);

  function clearAllFilters() {
    setNameQuery("");
    setPositionFilter("ALL");
    setStatusFilter("ALL");
    setScoreSort("desc");
  }

  function copyShareLink() {
    const url = window.location.href;
    navigator.clipboard?.writeText(url);
  }

  /* ---------------- UI helpers ---------------- */

  function HeaderCell({
    onClick,
    onKeyDown,
    children,
  }: {
    onClick?: (e: React.MouseEvent) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    children: React.ReactNode;
  }) {
    return (
      <th
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className="p-3 text-left cursor-pointer select-none outline-none focus:ring-2 focus:ring-white/40"
      >
        {children}
      </th>
    );
  }

  function OptionButton({
    active,
    onClick,
    children,
  }: {
    active?: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) {
    return (
      <button
        className={[
          "w-full text-left rounded-md px-3 py-2 text-sm transition",
          active ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-800",
        ].join(" ")}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-0 overflow-hidden">
      {/* Sticky PAGE header */}
      <div className="sticky top-0 z-30 bg-white border-b">
        <div className="p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">All Players</h1>
              <p className="text-xs text-slate-600">
                Score = rating×10 + stamina×2 + positionWeight×3
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-600">Showing {rows.length} player(s)</div>

              <button
                className="hidden md:inline border rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
                onClick={copyShareLink}
                title="Copy shareable link"
              >
                Copy link
              </button>

              <button
                className="md:hidden border rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => setDrawerOpen(true)}
              >
                Filters
              </button>
            </div>
          </div>

          {/* Chips */}
          <div className="flex flex-wrap items-center gap-2">
            {chips.length === 0 ? (
              <span className="text-xs text-slate-500">No filters applied</span>
            ) : (
              <>
                {chips.map((c) => (
                  <button
                    key={c.key}
                    className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-slate-50 text-xs hover:bg-slate-100"
                    onClick={c.onClear}
                    title="Click to clear"
                  >
                    <span className="text-slate-700">{c.label}</span>
                    <span className="text-slate-500">✕</span>
                  </button>
                ))}

                <button className="text-xs underline text-slate-600 ml-1" onClick={clearAllFilters}>
                  Clear all
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="p-5 space-y-6">
        {/* Top 5 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {top5.map((p) => (
            <div key={p.id} className="border rounded-xl p-3 bg-slate-50">
              <div className="font-semibold">{p.fullName}</div>
              <div className="text-xs text-slate-600">
                {positionLabel(p.position)} · {p.isActive ? "Active" : "Inactive"}
              </div>
              <div className="mt-2 text-lg font-bold">{p.score}</div>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-slate-900 text-white">
                <tr>
                  <HeaderCell
                    onClick={(e) => toggleMenu("name", e.currentTarget as HTMLElement)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleMenu("name", e.currentTarget as unknown as HTMLElement);
                      }
                      if (e.key === "Escape") closeAllOverlays();
                    }}
                  >
                    Name ▾
                  </HeaderCell>

                  <HeaderCell
                    onClick={(e) => toggleMenu("position", e.currentTarget as HTMLElement)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleMenu("position", e.currentTarget as unknown as HTMLElement);
                      }
                      if (e.key === "Escape") closeAllOverlays();
                    }}
                  >
                    Position ▾
                  </HeaderCell>

                  <HeaderCell
                    onClick={() => setScoreSort(scoreSort === "desc" ? "asc" : "desc")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setScoreSort(scoreSort === "desc" ? "asc" : "desc");
                      }
                    }}
                  >
                    Score {scoreSort === "desc" ? "↓" : "↑"}
                  </HeaderCell>

                  <HeaderCell
                    onClick={(e) => toggleMenu("status", e.currentTarget as HTMLElement)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleMenu("status", e.currentTarget as unknown as HTMLElement);
                      }
                      if (e.key === "Escape") closeAllOverlays();
                    }}
                  >
                    Status ▾
                  </HeaderCell>
                </tr>
              </thead>

              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-slate-50">
                    <td className="p-3">{p.fullName}</td>
                    <td className="p-3">{positionLabel(p.position)}</td>
                    <td className="p-3 font-semibold">{p.score}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-1 rounded-full text-xs border ${
                          p.isActive
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-slate-50 text-slate-600 border-slate-200"
                        }`}
                      >
                        {p.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-slate-600">
                      No players match filters
                    </td>
                  </tr>
                )}

                {loading && (
                  <tr>
                    <td colSpan={4} className="p-4 text-slate-600">
                      Loading...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---------------- Portal Popovers ---------------- */}
      <HeaderPopover
        open={openMenu === "name"}
        anchorEl={anchorEl}
        title="Filter by name"
        onClose={() => closeAllOverlays()}
      >
        <input
          ref={nameInputRef}
          className="w-full border rounded-md px-3 py-2 text-sm text-slate-900"
          placeholder="Type a name..."
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
        />
        <div className="flex justify-between pt-2">
          <button className="text-xs underline text-slate-600" onClick={() => setNameQuery("")}>
            Clear
          </button>
          <button className="text-xs underline text-slate-600" onClick={() => closeAllOverlays()}>
            Done
          </button>
        </div>
      </HeaderPopover>

      <HeaderPopover
        open={openMenu === "position"}
        anchorEl={anchorEl}
        title="Filter by position"
        onClose={() => closeAllOverlays()}
      >
        <div className="space-y-1">
          <OptionButton
            active={positionFilter === "ALL"}
            onClick={() => {
              setPositionFilter("ALL");
              closeAllOverlays();
            }}
          >
            All
          </OptionButton>

          {POSITIONS.map((pos) => (
            <OptionButton
              key={pos}
              active={positionFilter === pos}
              onClick={() => {
                setPositionFilter(pos);
                closeAllOverlays();
              }}
            >
              {positionLabel(pos)}
            </OptionButton>
          ))}
        </div>
      </HeaderPopover>

      <HeaderPopover
        open={openMenu === "status"}
        anchorEl={anchorEl}
        title="Filter by status"
        onClose={() => closeAllOverlays()}
      >
        <div className="space-y-1">
          {STATUS_OPTIONS.map((s) => (
            <OptionButton
              key={s.key}
              active={statusFilter === s.key}
              onClick={() => {
                setStatusFilter(s.key);
                closeAllOverlays();
              }}
            >
              {s.label}
            </OptionButton>
          ))}
        </div>
      </HeaderPopover>

      {/* ---------------- Mobile Filter Drawer ---------------- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close filters"
          />
          <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm bg-white shadow-xl p-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Filters</div>
              <button className="text-sm underline" onClick={() => setDrawerOpen(false)}>
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <div className="text-sm font-medium mb-1">Name</div>
                <input
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  placeholder="Search name..."
                  value={nameQuery}
                  onChange={(e) => setNameQuery(e.target.value)}
                />
                <div className="text-xs text-slate-500 mt-1">Debounced search (fast for big lists)</div>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">Position</div>
                <select
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
                  value={positionFilter}
                  onChange={(e) => setPositionFilter(e.target.value as PositionKey)}
                >
                  <option value="ALL">All</option>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {positionLabel(p)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">Status</div>
                <select
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusKey)}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">Sort by score</div>
                <div className="flex gap-2">
                  <button
                    className={`flex-1 border rounded-lg px-3 py-2 text-sm ${
                      scoreSort === "desc" ? "bg-slate-900 text-white" : "bg-white"
                    }`}
                    onClick={() => setScoreSort("desc")}
                  >
                    High → Low
                  </button>
                  <button
                    className={`flex-1 border rounded-lg px-3 py-2 text-sm ${
                      scoreSort === "asc" ? "bg-slate-900 text-white" : "bg-white"
                    }`}
                    onClick={() => setScoreSort("asc")}
                  >
                    Low → High
                  </button>
                </div>
              </div>

              <div className="pt-2 flex gap-2">
                <button className="flex-1 border rounded-lg px-3 py-2 text-sm" onClick={clearAllFilters}>
                  Reset
                </button>
                <button
                  className="flex-1 bg-slate-900 text-white rounded-lg px-3 py-2 text-sm"
                  onClick={() => setDrawerOpen(false)}
                >
                  Apply
                </button>
              </div>

              <button className="w-full text-xs underline text-slate-500 pt-2" onClick={copyShareLink}>
                Copy share link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
