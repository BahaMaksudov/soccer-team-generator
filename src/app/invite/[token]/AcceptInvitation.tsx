"use client";

import { useState } from "react";

export default function AcceptInvitation({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function accept() {
    if (loading) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error || "Could not accept the invitation.");
        setLoading(false);
        return;
      }
      window.location.href = "/admin";
    } catch {
      setErr("Could not accept the invitation.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {err && <div className="text-sm text-red-600" role="alert">{err}</div>}
      <button type="button" onClick={accept} disabled={loading}
        className="bg-black text-white rounded-md px-4 py-2 text-sm disabled:opacity-60">
        {loading ? "Accepting..." : "Accept invitation"}
      </button>
    </div>
  );
}
