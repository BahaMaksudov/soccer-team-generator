"use client";

import { useId, useState } from "react";
import { signIn } from "next-auth/react";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * UI-2 — interactive auth controls (presentation + the REAL NextAuth calls;
 * no simulated delays or fake success states).
 */

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };

export function Field({ label, error, hint, type = "text", className, id: idProp, ...rest }: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const [show, setShow] = useState(false);
  const isPassword = type === "password";
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={isPassword && show ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-12 w-full rounded-tbp border bg-card px-4 text-base outline-none transition-shadow focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/20 read-only:bg-muted read-only:text-muted-foreground",
            error ? "border-destructive" : "border-input",
            isPassword && "pr-12",
            className
          )}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            aria-controls={id}
            className="absolute right-1 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-tbp-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
          </button>
        )}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({ loading, children, loadingText, disabled }: { loading: boolean; children: React.ReactNode; loadingText: string; disabled?: boolean }) {
  return (
    <Button type="submit" size="xl" className="w-full" disabled={loading || disabled} aria-busy={loading}>
      {loading ? (
        <>
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * Starts the REAL NextAuth Google OAuth redirect. The browser leaves the page;
 * the outcome is decided server-side (src/lib/googleAuth.ts) and errors come
 * back as /login?error=<code>. `callbackUrl` must already be a sanitized
 * internal path (NextAuth's redirect callback re-checks it).
 */
export function GoogleButton({ callbackUrl }: { callbackUrl: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="xl"
      className="w-full bg-card font-semibold"
      disabled={loading}
      aria-busy={loading}
      onClick={() => {
        setLoading(true);
        void signIn("google", { callbackUrl }).catch(() => setLoading(false));
      }}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.56 10.56 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
      )}
      {loading ? "Connecting to Google…" : "Continue with Google"}
    </Button>
  );
}
