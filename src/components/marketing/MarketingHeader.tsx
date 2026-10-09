"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo, MARKETING_NAV, linkFocus } from "@/components/marketing/parts";
import { cn } from "@/lib/cn";

/**
 * UI-1 — marketing homepage header. Section anchors + Sign In / Get Started
 * (the existing /login and /signup). No auth state is read here on purpose.
 * The only client state is whether the mobile menu is open.
 */
/** `anchorBase`: "/" on pages other than the homepage, so section links ("#how") go to the homepage's sections. */
export default function MarketingHeader({ anchorBase = "" }: { anchorBase?: string } = {}) {
  const hrefOf = (href: string) => (href.startsWith("#") ? `${anchorBase}${href}` : href);
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {MARKETING_NAV.map((n) => (
            <a key={n.href} href={hrefOf(n.href)} className={cn("text-sm font-medium text-muted-foreground hover:text-foreground", linkFocus)}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild variant="ghost">
            <Link href="/login">Sign In</Link>
          </Button>
          <Button asChild className="rounded-full px-5">
            <Link href="/signup">Get Started</Link>
          </Button>
        </div>
        <button
          type="button"
          className={cn("grid size-11 place-items-center rounded-tbp-sm text-foreground md:hidden", linkFocus)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen(!open)}
        >
          {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t border-border bg-background px-4 pb-5 pt-2 md:hidden">
          {MARKETING_NAV.map((n) => (
            <a key={n.href} href={hrefOf(n.href)} onClick={() => setOpen(false)} className={cn("block px-2 py-3 font-medium text-foreground", linkFocus)}>
              {n.label}
            </a>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button asChild variant="outline" size="lg">
              <Link href="/login">Sign In</Link>
            </Button>
            <Button asChild size="lg">
              <Link href="/signup">Get Started</Link>
            </Button>
          </div>
        </nav>
      )}
    </header>
  );
}
