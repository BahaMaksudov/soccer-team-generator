import Link from "next/link";
import { Clock } from "lucide-react";
import type { TrialBannerView } from "@/lib/trialBanner";

/**
 * M11.3 — trial banner for OWNER/ADMIN (server-computed: lib/trialBanner). Shows
 * while the trial is ending and for a while after it ended. Never a payment link
 * while billing is off — then the honest "coming soon" text (+ contact if set).
 */
export function TrialBanner({ view }: { view: TrialBannerView }) {
  return (
    <div role="status" className="mb-6 flex min-w-0 flex-wrap items-start gap-3 rounded-tbp-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <Clock className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{view.title}</p>
        <p className="break-words">{view.body}</p>
        {!view.upgradeHref && view.hint && <p className="break-words text-amber-900/80 dark:text-amber-100/80">{view.hint}</p>}
      </div>
      {view.upgradeHref && (
        <Link href={view.upgradeHref} className="inline-flex h-9 shrink-0 items-center rounded-tbp-sm bg-primary px-3 font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          Upgrade to Pro
        </Link>
      )}
    </div>
  );
}
