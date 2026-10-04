"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { signOut } from "next-auth/react";
import {
  Building2,
  CalendarDays,
  Check,
  ChevronsUpDown,
  Layers,
  LayoutGrid,
  Loader2,
  LogOut,
  MoreHorizontal,
  Ticket,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  buildShellNav,
  initialsOf,
  ROLE_LABELS,
  shellContextFromPath,
  SIGN_OUT_DESTINATION,
  switcherEntries,
  type NavItem,
  type NavKey,
  type ShellData,
} from "@/lib/appShell";
import { cn } from "@/lib/cn";

/**
 * UI-3 — interactive parts of the authenticated shell (navigation state,
 * menus, Sign Out). Presentation only: every list comes from the
 * server-authorized ShellData prop; links are plain navigations whose
 * targets re-check access server-side. No tenant/role state is stored
 * (no localStorage, cookies or context); the URL is the only selection.
 */

const ICONS: Record<NavKey, LucideIcon> = {
  overview: LayoutGrid,
  matches: CalendarDays,
  players: Users,
  groups: Layers,
  "my-games": Ticket,
  organization: Building2,
  account: UserRound,
};

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-pitch";
const focusRingLight = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// --- current URL hash. In-page section links don't fire `hashchange` under the
// App Router (and the URL updates after the click), so a clicked link's hash is
// used until the browser reports a real hash change / history navigation.
const HASH_EVENT = "tbp:hash";
let clicked: { path: string; hash: string } | null = null;
const subscribeHash = (cb: () => void) => {
  const reset = () => {
    clicked = null;
    cb();
  };
  window.addEventListener("hashchange", reset);
  window.addEventListener("popstate", reset);
  window.addEventListener(HASH_EVENT, cb);
  return () => {
    window.removeEventListener("hashchange", reset);
    window.removeEventListener("popstate", reset);
    window.removeEventListener(HASH_EVENT, cb);
  };
};
function useHash(): string {
  // A clicked hash applies only while we're still on the page it pointed at.
  return useSyncExternalStore(subscribeHash, () => (clicked && clicked.path === window.location.pathname ? clicked.hash : window.location.hash), () => "");
}
function announceHash(href: string) {
  const url = new URL(href, window.location.href);
  clicked = { path: url.pathname, hash: url.hash };
  window.dispatchEvent(new Event(HASH_EVENT));
}

function useNav(data: ShellData): NavItem[] {
  const pathname = usePathname() ?? "";
  const hash = useHash();
  return buildShellNav({ data, pathname, hash });
}

// --- small disclosure helper: Escape / outside click close, focus returns to the trigger
function useDisclosure() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);
  // Close on navigation.
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return { open, setOpen, close, triggerRef, panelRef };
}

// --- Sign Out (NextAuth signOut; always lands on a same-origin relative path)
export function SignOutButton({ className, onDark = true }: { className?: string; onDark?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function run() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // redirect:false — NextAuth clears the session cookie; we then navigate to a
      // RELATIVE path, so the browser stays on the current deployment's origin.
      await signOut({ redirect: false });
      window.location.assign(SIGN_OUT_DESTINATION);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-busy={busy}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-tbp-sm px-3 text-left text-sm font-medium disabled:opacity-60",
          onDark ? cn("hover:bg-pitch-foreground/10", focusRing) : cn("hover:bg-muted", focusRingLight),
          className
        )}
      >
        {busy ? <Loader2 className="size-[18px] animate-spin" aria-hidden="true" /> : <LogOut className="size-[18px]" aria-hidden="true" />}
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="alert" className="px-3 text-xs text-destructive">
          Couldn&apos;t sign out. Please try again.
        </p>
      )}
    </>
  );
}

// --- desktop sidebar navigation
export function SidebarNav({ data }: { data: ShellData }) {
  const items = useNav(data);
  const sections = (["main", "personal", "admin"] as const).map((s) => items.filter((i) => i.section === s)).filter((l) => l.length > 0);
  return (
    <nav aria-label="Application" className="mt-4 flex-1 space-y-4 overflow-y-auto px-3">
      {sections.map((list, idx) => (
        <ul key={list[0].section} className={cn("space-y-0.5", idx > 0 && "border-t border-pitch-foreground/10 pt-4")}>
          {list.map((i) => {
            const Icon = ICONS[i.key];
            return (
              <li key={i.key}>
                <Link
                  href={i.href}
                  onClick={() => announceHash(i.href)}
                  aria-current={i.active ? "page" : undefined}
                  className={cn(
                    "relative flex min-h-11 items-center gap-3 rounded-tbp-sm px-3 text-sm font-medium transition-colors",
                    i.active ? "bg-pitch-foreground/15 font-bold text-pitch-foreground" : "text-pitch-foreground/75 hover:bg-pitch-foreground/10 hover:text-pitch-foreground",
                    focusRing
                  )}
                >
                  {/* Selected state is not color-only: a visible bar + bold label (+ aria-current). */}
                  {i.active && <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-accent" aria-hidden="true" />}
                  <Icon className="size-[18px] shrink-0" aria-hidden="true" />
                  {i.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}

// --- group switcher (navigation only)
export function GroupSwitcher({ data, mobile = false }: { data: ShellData; mobile?: boolean }) {
  const pathname = usePathname() ?? "";
  const ctx = shellContextFromPath(pathname, data.organizations);
  const entries = switcherEntries(data.organizations, ctx);
  const { open, setOpen, triggerRef, panelRef } = useDisclosure();
  const panelId = useId();
  if (data.organizations.length === 0) return null;

  const orgLabel = ctx?.organization.name ?? "Workspace";
  const groupLabel = ctx?.group?.name ?? (ctx ? "Choose a group" : "Choose a group");
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Switch group. Current: ${ctx ? `${ctx.organization.name}${ctx.group ? `, ${ctx.group.name}` : ""}` : "none selected"}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-tbp text-left text-pitch-foreground hover:bg-pitch-foreground/10",
          mobile ? "min-h-11 px-2" : "border border-pitch-foreground/10 bg-pitch-foreground/5 p-2.5",
          focusRing
        )}
      >
        {!mobile && (
          <span className="grid size-8 shrink-0 place-items-center rounded-tbp-sm bg-accent font-display text-sm font-black text-accent-foreground" aria-hidden="true">
            {(ctx?.organization.name ?? "W").slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs opacity-70">{orgLabel}</span>
          <span className="block truncate text-sm font-semibold">{groupLabel}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-70" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className={cn(
            "absolute z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-tbp border border-border bg-card p-1.5 text-card-foreground shadow-lift",
            mobile ? "left-0 w-[min(18rem,calc(100vw-2rem))]" : "inset-x-0"
          )}
        >
          <nav aria-label="Switch group">
            {entries.map((o) => (
              <div key={o.organization.slug} className="py-1">
                <p className="truncate px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                  {o.organization.name} <span className="font-normal">· {o.organization.roleLabel}</span>
                </p>
                {o.groups.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-sm text-muted-foreground">No active groups</p>
                ) : (
                  <ul>
                    {o.groups.map((g) => (
                      <li key={g.slug}>
                        <Link
                          href={g.href}
                          aria-current={g.current ? "page" : undefined}
                          className={cn("flex min-h-10 items-center gap-2 rounded-tbp-sm px-2.5 text-sm hover:bg-muted", g.current && "font-semibold", focusRingLight)}
                        >
                          <span className="min-w-0 flex-1 truncate">{g.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{g.sportLabel}</span>
                          {g.current && <Check className="size-4 shrink-0 text-primary" aria-label="Current group" />}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {data.workspaceListAvailable && (
              <div className="border-t border-border pt-1">
                <Link href="/admin" className={cn("flex min-h-10 items-center rounded-tbp-sm px-2.5 text-sm font-medium text-primary hover:bg-muted", focusRingLight)}>
                  View all workspaces
                </Link>
              </div>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}

// --- account menu (identity, real role, Account, Sign Out)
export function AccountMenu({ data, mobile = false }: { data: ShellData; mobile?: boolean }) {
  const pathname = usePathname() ?? "";
  const ctx = shellContextFromPath(pathname, data.organizations);
  const role = ctx ? ROLE_LABELS[ctx.organization.role] : null;
  const display = data.user.name?.trim() || data.user.email;
  const { open, setOpen, triggerRef, panelRef } = useDisclosure();
  const panelId = useId();
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Account menu"
        onClick={() => setOpen(!open)}
        className={cn("flex min-h-11 items-center gap-3 rounded-tbp-sm p-1.5 text-left text-pitch-foreground hover:bg-pitch-foreground/10", mobile ? "w-auto" : "w-full", focusRing)}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-pitch-foreground/15 text-xs font-bold" aria-hidden="true">
          {initialsOf(data.user.name, data.user.email)}
        </span>
        {!mobile && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{display}</span>
            <span className="block truncate text-xs opacity-70">{role ? `${role}${ctx ? ` · ${ctx.organization.name}` : ""}` : data.user.email}</span>
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className={cn(
            "absolute z-50 w-64 rounded-tbp border border-border bg-card p-1.5 text-card-foreground shadow-lift",
            mobile ? "right-0 top-full mt-2" : "bottom-full left-0 mb-2"
          )}
        >
          <div className="border-b border-border px-2.5 pb-2 pt-1">
            <p className="truncate text-sm font-semibold">{display}</p>
            <p className="truncate text-xs text-muted-foreground">{data.user.email}</p>
            {role && <p className="mt-0.5 truncate text-xs text-muted-foreground">Role: {role} · {ctx!.organization.name}</p>}
          </div>
          <ul className="pt-1">
            <li>
              <Link href="/account/security" className={cn("flex min-h-11 items-center gap-3 rounded-tbp-sm px-3 text-sm font-medium hover:bg-muted", focusRingLight)}>
                <UserRound className="size-[18px]" aria-hidden="true" />
                Account
              </Link>
            </li>
            <li>
              <SignOutButton onDark={false} />
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

// --- mobile bottom navigation (+ "More" sheet)
export function MobileBottomNav({ data }: { data: ShellData }) {
  const items = useNav(data);
  const primary = items.filter((i) => i.mobilePrimary).slice(0, 4);
  const rest = items.filter((i) => !primary.includes(i));
  const { open, setOpen, close, triggerRef, panelRef } = useDisclosure();
  const sheetId = useId();
  return (
    <nav aria-label="Application (mobile)" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="flex">
        {primary.map((i) => {
          const Icon = ICONS[i.key];
          return (
            <li key={i.key} className="min-w-0 flex-1">
              <Link
                href={i.href}
                onClick={() => announceHash(i.href)}
                aria-current={i.active ? "page" : undefined}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium",
                  i.active ? "font-bold text-primary" : "text-muted-foreground",
                  focusRingLight
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className={cn("max-w-full truncate", i.active && "underline decoration-2 underline-offset-4")}>{i.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={sheetId}
            onClick={() => setOpen(!open)}
            className={cn("flex min-h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground", focusRingLight)}
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
            More
          </button>
        </li>
      </ul>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-foreground/30" aria-hidden="true" onClick={() => close(false)} />
          <div ref={panelRef} id={sheetId} role="dialog" aria-modal="true" aria-label="More" className="fixed inset-x-0 bottom-0 z-50 rounded-t-tbp-2xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lift">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-display text-lg font-extrabold">More</p>
              <button type="button" onClick={() => close()} aria-label="Close menu" className={cn("grid size-11 place-items-center rounded-tbp-sm hover:bg-muted", focusRingLight)}>
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <ul className="space-y-1">
              {rest.map((i) => {
                const Icon = ICONS[i.key];
                return (
                  <li key={i.key}>
                    <Link
                      href={i.href}
                      onClick={() => {
                        announceHash(i.href);
                        close(false);
                      }}
                      aria-current={i.active ? "page" : undefined}
                      className={cn("flex min-h-12 items-center gap-3 rounded-tbp-sm px-3 font-medium hover:bg-muted", i.active && "font-bold", focusRingLight)}
                    >
                      <Icon className="size-5 text-primary" aria-hidden="true" />
                      {i.label}
                    </Link>
                  </li>
                );
              })}
              <li className="border-t border-border pt-1">
                <SignOutButton onDark={false} className="min-h-12 text-base" />
              </li>
            </ul>
          </div>
        </>
      )}
    </nav>
  );
}
