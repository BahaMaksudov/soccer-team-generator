"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <div className="space-y-3">
      <Button variant="outline" size="xl" className="w-full" onClick={resend} disabled={loading} aria-busy={loading}>
        {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {loading ? "Sending…" : "Resend verification email"}
      </Button>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-center text-sm ${msg.ok ? "text-primary" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
