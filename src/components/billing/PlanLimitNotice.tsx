"use client";

import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Fix A — one way to show a plan limit everywhere in the organization's pages.
 * The message itself comes from the server (it names the Free allowance and
 * what Pro adds). The ACTION depends on who is looking, decided on the server
 * by the organization layout (PlanLimitProvider):
 *   - Free + OWNER + billing on → "Upgrade to Pro" link to THIS organization's
 *     Billing page (navigation only — Checkout starts only from that page);
 *   - Free + anyone else        → "Ask your organization owner to upgrade to Pro.";
 *   - any other plan            → no upgrade action; a support contact if configured.
 */
export type PlanLimitViewer = {
  /** Only for the OWNER while billing is on: this organization's Billing page. */
  upgradeHref: string | null;
  isOwner: boolean;
  billingEnabled: boolean;
  /** The organization's effective plan ("FREE", "TRIAL", "PRO", …), as the server saw it. */
  plan: string;
  supportEmail: string | null;
};

const PlanLimitContext = createContext<PlanLimitViewer | null>(null);

export function PlanLimitProvider({ value, children }: { value: PlanLimitViewer | null; children: ReactNode }) {
  return <PlanLimitContext.Provider value={value}>{children}</PlanLimitContext.Provider>;
}

/** A 402 PLAN_LIMIT reply → what PlanLimitNotice needs; anything else → null. */
export function planLimitFrom(data: unknown): { message: string; plan: string | null } | null {
  const d = data as { code?: unknown; error?: unknown; plan?: unknown } | null;
  if (!d || d.code !== "PLAN_LIMIT" || typeof d.error !== "string") return null;
  return { message: d.error, plan: typeof d.plan === "string" ? d.plan : null };
}

export default function PlanLimitNotice({ message, plan, className }: { message: string; plan?: string | null; className?: string }) {
  const viewer = useContext(PlanLimitContext);
  const effective = plan ?? viewer?.plan ?? null;
  const free = effective === "FREE";
  return (
    <div role="alert" className={cn("rounded-tbp border border-accent/40 bg-accent/10 px-3 py-2 text-sm", className)}>
      <p className="break-words">{message}</p>
      {viewer && free && viewer.billingEnabled && viewer.upgradeHref && (
        <Link
          href={viewer.upgradeHref}
          className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-tbp-sm bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Upgrade to Pro <ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>
      )}
      {viewer && free && viewer.billingEnabled && !viewer.upgradeHref && <p className="mt-1.5 font-semibold">Ask your organization owner to upgrade to Pro.</p>}
      {viewer && !free && effective !== null && viewer.supportEmail && (
        <p className="mt-1.5 text-muted-foreground">
          Need more? Contact{" "}
          <a href={`mailto:${viewer.supportEmail}`} className="font-semibold text-foreground underline underline-offset-2">
            {viewer.supportEmail}
          </a>
          .
        </p>
      )}
    </div>
  );
}
