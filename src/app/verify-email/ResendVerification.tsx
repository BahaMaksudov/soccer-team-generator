"use client";

import { useState } from "react";

export default function ResendVerification({ next }: { next: string | null }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function resend() {
    if (loading) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/account/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ? { next } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.alreadyVerified) {
        window.location.href = next || "/admin";
        return;
      }
      setMsg(res.ok ? { ok: true, text: "A new verification link is on its way. Older links no longer work." } : { ok: false, text: data?.error || "Could not resend the email." });
    } catch {
      setMsg({ ok: false, text: "Could not resend the email." });
    }
    setLoading(false);
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={resend} disabled={loading}
        className="border rounded-md px-4 py-2 text-sm disabled:opacity-60">
        {loading ? "Sending..." : "Resend verification email"}
      </button>
      {msg && <div className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</div>}
    </div>
  );
}
