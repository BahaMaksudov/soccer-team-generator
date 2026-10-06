import Link from "next/link";
import { Scale } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * UI-1 — marketing homepage building blocks (presentation only; visual
 * reference: the approved Lovable homepage). Static illustrative content only.
 */

/**
 * Homepage section anchors. Lives here (a server-safe module) — NOT in the
 * "use client" MarketingHeader — because server components that import a
 * plain value from a client module receive a client reference, not the value.
 */
export const MARKETING_NAV = [
  { href: "#how", label: "How It Works" },
  { href: "#features", label: "Features" },
  { href: "#sports", label: "Sports" },
] as const;

/** Focus treatment for plain text links on the marketing page (buttons bring their own ring). */
export const linkFocus = "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function Logo({ onDark = false }: { onDark?: boolean }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2", linkFocus)} aria-label="Team Balance Pro home">
      <span className="grid size-8 place-items-center rounded-tbp-sm bg-primary text-primary-foreground" aria-hidden="true">
        <Scale className="size-4" />
      </span>
      <span className={cn("font-display text-lg font-extrabold tracking-tight", onDark ? "text-pitch-foreground" : "text-foreground")} aria-hidden="true">
        Team Balance <span className="text-accent">Pro</span>
      </span>
    </Link>
  );
}

export function TeamColumn({ name, players, tone }: { name: string; players: string[]; tone: "a" | "b" }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("size-2.5 rounded-full", tone === "a" ? "bg-team-a" : "bg-team-b")} aria-hidden="true" />
        <h4 className="text-sm font-bold">{name}</h4>
      </div>
      <ul className="space-y-1.5">
        {players.map((p) => (
          <li key={p} className="flex items-center gap-2 rounded-tbp-sm bg-muted px-2.5 py-2 text-sm font-medium">
            <span
              className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-primary-foreground", tone === "a" ? "bg-team-a" : "bg-team-b")}
              aria-hidden="true"
            >
              {p[0]}
            </span>
            <span className="truncate">{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BalanceBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-bold text-secondary-foreground">
      <Scale className="size-3.5" aria-hidden="true" /> Balance: Even
    </span>
  );
}

export function SectionHead({ eyebrow, title, body, center = false, id }: { eyebrow: string; title: string; body?: string; center?: boolean; id?: string }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-3xl font-extrabold sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-lg text-muted-foreground">{body}</p>}
    </div>
  );
}
