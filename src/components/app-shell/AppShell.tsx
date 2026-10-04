import Link from "next/link";
import { Scale } from "lucide-react";
import type { ShellData } from "@/lib/appShell";
import { cn } from "@/lib/cn";
import { AccountMenu, GroupSwitcher, MobileBottomNav, SidebarNav, SignOutButton } from "./ShellClient";

/**
 * UI-3 — authenticated application shell (visual reference: the approved
 * Lovable app shell). A SERVER component: the page (`children`) is rendered
 * directly inside <main> — never through a client wrapper — so nested
 * notFound()/redirect() keep normal server rendering. Only the navigation
 * pieces are client components, fed with server-authorized ShellData.
 */
function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/admin"
      className={cn("flex items-center gap-2 rounded-tbp-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}
      aria-label="Team Balance Pro workspaces"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-tbp-sm bg-primary text-primary-foreground" aria-hidden="true">
        <Scale className="size-4" />
      </span>
      <span className="font-display font-extrabold tracking-tight" aria-hidden="true">
        Team Balance <span className="text-accent">Pro</span>
      </span>
    </Link>
  );
}

export default function AppShell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-screen bg-background font-body text-foreground antialiased lg:flex",
        "[&_h1]:font-display [&_h2]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]"
      )}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-tbp-sm focus:bg-card focus:px-4 focus:py-2 focus:font-semibold focus:shadow-lift focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-pitch text-pitch-foreground lg:flex" aria-label="Sidebar">
        <div className="flex h-16 items-center px-4">
          <Brand />
        </div>
        <div className="px-3">
          <GroupSwitcher data={data} />
        </div>
        <SidebarNav data={data} />
        <div className="space-y-1 border-t border-pitch-foreground/10 p-3">
          <AccountMenu data={data} />
          {/* Sign Out is directly visible, not only inside the account menu. */}
          <SignOutButton className="text-pitch-foreground/80 hover:text-pitch-foreground" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-pitch px-3 text-pitch-foreground lg:hidden">
          {data.organizations.length > 0 ? (
            <>
              <Link
                href="/admin"
                aria-label="Team Balance Pro workspaces"
                className="grid size-8 shrink-0 place-items-center rounded-tbp-sm bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Scale className="size-4" aria-hidden="true" />
              </Link>
              <div className="min-w-0 flex-1">
                <GroupSwitcher data={data} mobile />
              </div>
            </>
          ) : (
            <Brand className="min-w-0 flex-1" />
          )}
          <AccountMenu data={data} mobile />
        </header>

        <main id="main" tabIndex={-1} className="flex-1 px-4 pb-28 pt-6 focus:outline-none sm:px-6 lg:px-8 lg:pb-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>

      <MobileBottomNav data={data} />
    </div>
  );
}
