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

  if (done) return <div className="text-sm text-green-700">Password changed. Signing you out…</div>;

  return (
    <form onSubmit={submit} className="space-y-3">
      {err && <div className="text-sm text-red-600" role="alert">{err}</div>}
      <div>
        <label className="block text-sm mb-1" htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" type="password" className="w-full border rounded-md px-3 py-2" value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
      </div>
      <div>
        <label className="block text-sm mb-1" htmlFor="newPassword">New password</label>
        <input id="newPassword" type="password" className="w-full border rounded-md px-3 py-2" value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        <div className="text-xs text-gray-500 mt-1">At least 8 characters.</div>
      </div>
      <div>
        <label className="block text-sm mb-1" htmlFor="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" type="password" className="w-full border rounded-md px-3 py-2" value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" className="w-full bg-black text-white rounded-md py-2 disabled:opacity-60" disabled={loading}>
        {loading ? "Changing..." : "Change password"}
      </button>
    </form>
  );
}
