"use client";

import { useState } from "react";
import { signIn, signOut } from "next-auth/react";

/**
 * M12-A — Connect / disconnect Google (password accounts only). Both ask for the
 * current password; connecting then completes Google sign-in, and the server
 * connects that Google account only if its verified email equals this account's.
 */
const input = "h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm";
const button = "inline-flex h-11 w-full items-center justify-center rounded-tbp-md px-4 text-sm font-semibold disabled:opacity-60 sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export default function GoogleConnection({ linked, email }: { linked: boolean; email: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/google-link", { method: linked ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: password }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(res.status === 401 ? "Your session has expired. Please sign in again." : (data.error ?? "Something went wrong. Please try again."));
        setBusy(false);
        return;
      }
      setPassword("");
      if (linked) await signOut({ callbackUrl: "/login?googleDisconnected=1" });
      else await signIn("google", { callbackUrl: "/account/security?google=connected" });
    } catch {
      setErr("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={`${button} ${linked ? "border border-destructive/40 text-destructive hover:bg-destructive/5" : "border border-input bg-card hover:bg-muted"}`} onClick={() => setOpen(true)}>
        {linked ? "Disconnect Google" : "Connect Google"}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {linked ? (
          <>Disconnecting signs you out everywhere. Afterwards you sign in with your email and password.</>
        ) : (
          <>
            Confirm your password, then choose the Google account for <span className="break-all font-semibold text-foreground">{email}</span>. A Google account with a different email can&apos;t be connected.
          </>
        )}
      </p>
      {err && <div className="text-sm text-destructive" role="alert">{err}</div>}
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="googleLinkPassword">Current password</label>
        <input id="googleLinkPassword" type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" disabled={busy} aria-busy={busy} className={`${button} bg-primary text-primary-foreground hover:opacity-90`}>
          {busy ? "Please wait…" : linked ? "Disconnect Google" : "Continue to Google"}
        </button>
        <button type="button" className={`${button} border border-input bg-card hover:bg-muted`} onClick={() => { setOpen(false); setErr(null); setPassword(""); }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
