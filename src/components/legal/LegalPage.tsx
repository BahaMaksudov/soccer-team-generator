import Link from "next/link";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { linkFocus } from "@/components/marketing/parts";
import { cn } from "@/lib/cn";
import { LEGAL_PATHS, OWNER_ITEMS, legalIsDraft } from "@/lib/legal";

/**
 * Layout of the public legal pages: marketing header, a readable single column,
 * and — while any owner item is open (src/lib/legal.ts) — a draft banner.
 * Public, never auth-gated, no personal data.
 */
export function OwnerTodo({ id, children }: { id: string; children?: React.ReactNode }) {
  const item = OWNER_ITEMS.find((i) => i.id === id);
  return (
    <mark data-owner-item={id} className="rounded-sm bg-accent/20 px-1 font-semibold text-foreground">
      [Owner to confirm: {children ?? item?.label ?? id}]
    </mark>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <h2 id={`${id}-h`} className="text-xl font-extrabold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function LegalPage({ title, intro, children }: { title: string; intro: React.ReactNode; children: React.ReactNode }) {
  const draft = legalIsDraft();
  return (
    <div className={cn("min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased", "[&_h1]:font-display [&_h2]:font-display [&_h1]:tracking-[-0.02em] [&_h2]:tracking-[-0.02em]")}>
      <MarketingHeader anchorBase="/" />
      <main id="main" className="mx-auto w-full max-w-3xl space-y-8 px-4 py-10 sm:py-14">
        {draft && (
          <div role="note" className="rounded-tbp-xl border border-accent bg-accent/10 p-4 text-sm">
            <p className="font-bold">Draft for owner review — not yet a final policy.</p>
            <p className="mt-1 text-muted-foreground">Items marked &quot;Owner to confirm&quot; still need the owner&apos;s decision before this page is published.</p>
          </div>
        )}
        <header className="space-y-3">
          <h1 className="text-4xl font-black leading-tight">{title}</h1>
          <div className="text-muted-foreground">{intro}</div>
        </header>
        <div className="space-y-8 text-[15px] leading-relaxed [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-1.5">{children}</div>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-6 text-sm">
          <Link href={LEGAL_PATHS.privacy} className={cn("font-semibold hover:underline", linkFocus)}>
            Privacy Policy
          </Link>
          <Link href={LEGAL_PATHS.terms} className={cn("font-semibold hover:underline", linkFocus)}>
            Terms of Service
          </Link>
          <Link href="/" className={cn("hover:underline", linkFocus)}>
            Home
          </Link>
        </nav>
      </main>
    </div>
  );
}
