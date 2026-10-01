"use client";

import { useState } from "react";

export default function VerifyEmailButton({ token, next }: { token: string; next: string | null }) {
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function verify() {
    if (loading) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error || "Could not verify your email.");
        setLoading(false);
        return;
      }
      setDone(true);
      // `next` was sanitized server-side (internal path only).
      window.location.href = next || "/admin";
    } catch {
      setErr("Could not verify your email.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {err && <div className="text-sm text-red-600" role="alert">{err}</div>}
      {done ? (
        <div className="text-sm text-green-700">Email verified. Continuing…</div>
      ) : (
        <button type="button" onClick={verify} disabled={loading}
          className="bg-black text-white rounded-md px-4 py-2 text-sm disabled:opacity-60">
          {loading ? "Verifying..." : "Verify email"}
        </button>
      )}
    </div>
  );
}
