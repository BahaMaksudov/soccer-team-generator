import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BalanceBadge, Logo, TeamColumn, linkFocus } from "@/components/marketing/parts";
import { cn } from "@/lib/cn";

/**
 * UI-2 — split-screen authentication layout (visual reference: the approved
 * Lovable auth screens). Presentation only: the illustrative team card uses
 * made-up names and no real data. The page's single <h1> is the form title
 * (FormHead); the side-panel headline is decorative-sized text.
 */
export default function AuthLayout({ headline, body, children }: { headline: string; body: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased lg:grid-cols-[1fr_1.1fr]",
        // Display font + tight tracking for these pages' headings only (no global restyle).
        "[&_h1]:font-display [&_h2]:font-display [&_h3]:font-display [&_h4]:font-display",
        "[&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em] [&_h3]:tracking-[-0.02em] [&_h4]:tracking-[-0.02em]"
      )}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-tbp-sm focus:bg-card focus:px-4 focus:py-2 focus:font-semibold focus:shadow-lift focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <aside className="pitch-lines relative hidden flex-col justify-between bg-pitch p-10 text-pitch-foreground lg:flex xl:p-14">
        <Logo onDark />
        <div className="max-w-md">
          <p className="font-display text-4xl font-black leading-tight tracking-[-0.02em] xl:text-5xl">{headline}</p>
          <p className="mt-4 text-lg opacity-80">{body}</p>
          <div className="mt-10 rounded-tbp-2xl bg-card p-5 text-card-foreground shadow-lift" aria-hidden="true">
            <div className="flex items-center justify-between gap-3">
              <p className="font-display font-extrabold">Sunday Pickup Soccer</p>
              <BalanceBadge />
            </div>
            <div className="mt-4 flex gap-3">
              <TeamColumn name="Team 1" players={["Alex", "Ben", "Carla"]} tone="a" />
              <TeamColumn name="Team 2" players={["Femi", "Gabe", "Hana"]} tone="b" />
            </div>
          </div>
        </div>
        <p className="text-sm opacity-60">© {new Date().getFullYear()} Team Balance Pro</p>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border px-4 sm:px-6 lg:border-0">
          <div className="lg:invisible">
            <Logo />
          </div>
          <Link
            href="/"
            className={cn("inline-flex min-h-11 items-center gap-1.5 px-2 text-sm font-medium text-muted-foreground hover:text-foreground", linkFocus)}
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Back to home
          </Link>
        </header>
        <div className="bg-pitch px-4 py-6 text-pitch-foreground sm:px-6 lg:hidden">
          <p className="font-display text-xl font-extrabold">{headline}</p>
        </div>
        <main id="main" className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6 lg:items-center">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
