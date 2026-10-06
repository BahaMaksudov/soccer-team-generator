"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

function firstError(data: unknown): string {
  const d = data as { error?: string; issues?: { fieldErrors?: Record<string, string[]> } };
  const field = d?.issues?.fieldErrors && Object.values(d.issues.fieldErrors).flat()[0];
  return field || d?.error || "Could not change your password. Please try again.";
}

export default function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setErr(null);
    if (newPassword !== confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/account/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(res.status === 401 ? "Your session has expired. Please sign in again." : firstError(data));
        setLoading(false);
        return;
      }
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // Sign out everywhere this browser is signed in; sign in again with the new password.
      await signOut({ callbackUrl: "/login?passwordChanged=1" });
    } catch {
      setErr("Could not change your password. Please try again.");
      setLoading(false);
    }
  }

  if (done) return <div role="status" className="text-sm font-semibold text-primary">Password changed. Signing you out…</div>;

  return (
    <form onSubmit={submit} className="space-y-3">
      {err && <div className="text-sm text-destructive" role="alert">{err}</div>}
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" type="password" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
      </div>
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="newPassword">New password</label>
        <input id="newPassword" type="password" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        <div className="mt-1 text-xs text-muted-foreground">At least 8 characters.</div>
      </div>
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" type="password" className="h-11 w-full rounded-tbp-md border border-input bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60" disabled={loading} aria-busy={loading}>
        {loading ? "Changing..." : "Change password"}
      </button>
    </form>
  );
}
