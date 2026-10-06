import Link from "next/link";
import { AlertCircle, Info, MailCheck } from "lucide-react";
import { linkFocus } from "@/components/marketing/parts";
import { cn } from "@/lib/cn";

/** UI-2 — server-safe auth building blocks (presentation only). */

export function FormHead({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-3xl font-extrabold">{title}</h1>
      {body && <p className="mt-2 text-muted-foreground">{body}</p>}
    </div>
  );
}

export function OrDivider({ label }: { label: string }) {
  return (
    <div className="my-6 flex items-center gap-3 text-xs font-medium text-muted-foreground" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="text-center" aria-hidden="true">{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

export function FormAlert({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-tbp border border-destructive/30 bg-destructive/5 p-3.5 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function SuccessNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="flex gap-2.5 rounded-tbp bg-secondary p-4 text-sm">
      <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-primary" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <p>{children}</p>
    </div>
  );
}

export function InfoNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="mt-10 flex gap-3 rounded-tbp border border-border bg-muted p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1 text-muted-foreground">{children}</p>
      </div>
    </aside>
  );
}

export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("font-semibold text-primary hover:underline", linkFocus)}>
      {children}
    </Link>
  );
}

/** Centered status card for the email-verification states. */
export function StatusCard({ title, children, icon = true }: { title: string; children: React.ReactNode; icon?: boolean }) {
  return (
    <div className="rounded-tbp-2xl border border-border bg-card p-8 text-center shadow-card">
      {icon && (
        <span className="mx-auto grid size-16 place-items-center rounded-full bg-secondary text-primary" aria-hidden="true">
          <MailCheck className="size-8" />
        </span>
      )}
      <h1 className={cn("text-3xl font-extrabold", icon && "mt-6")}>{title}</h1>
      <div className="mt-3 space-y-3 text-muted-foreground">{children}</div>
    </div>
  );
}
